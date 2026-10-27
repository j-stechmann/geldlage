/**
 * Planned-transaction service (ADR-0035): CRUD, occurrence expansion +
 * read-time matching, and the forecast. All reads/writes are user-scoped
 * like every other domain table. Money stays integer cents (ADR-0002).
 */
import { and, eq, inArray, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { getDb } from "@/lib/db"
import {
  accounts,
  categories,
  importBatches,
  plannedTransactions,
  transactions,
  type PlanStatus,
} from "@/lib/db/schema"
import { normalizeWhitespace } from "@/lib/money"
import {
  expandOccurrenceDates,
  isValidIsoDate,
  isoDatePlus,
  isEmptyRule,
  nextOccurrenceDate,
  RuleValidationError,
  validateRrule,
} from "@/lib/planning/recurrence"
import {
  matchPlannedOccurrences,
  MATCH_DAYS_AFTER,
  MATCH_DAYS_BEFORE,
  type MatchCandidate,
  type MatchableOccurrence,
} from "@/lib/planning/matching"
import { MAX_COUNTERPARTY, MAX_TEXT } from "@/lib/planning/limits"
import { todayLocal } from "@/lib/analytics/date"

/**
 * dtstart floor (year): occurrence expansion walks forward from dtstart on
 * every read (plan list, occurrences, forecast) and rrule has no internal
 * iteration cap — a pre-1900 dtstart would make each request iterate
 * centuries per plan for no representable purpose.
 */
const MIN_DTSTART_YEAR = 1900
/** occurrence-window cap for the occurrences endpoint (days) */
export const MAX_OCCURRENCE_WINDOW_DAYS = 400
/**
 * Window distance cap, each side of today (= 60 months, the forecast
 * horizon cap). rrule expansion iterates occurrence by occurrence from
 * dtstart up to the window start — it cannot seek — so an arbitrary far
 * window would make every recurring plan cost CPU linear in that distance
 * on every read (measured: ~0.6 s per DAILY plan for a window at year
 * 2999, ~6 s at 9999). Everything that actually queries occurrences stays
 * far inside: the /planung calendar navigates month-sized windows.
 */
export const MAX_WINDOW_DISTANCE_DAYS = 1826
/** forecast horizon cap (months) */
export const MAX_FORECAST_MONTHS = 60

export interface PlanInput {
  accountId?: number | null
  counterparty?: string | null
  purpose?: string | null
  /** signed cents — required on create, optional on patch (only provided keys update) */
  amountCents?: number
  categoryId?: number | null
  dtstart?: string
  /** NULL/"" = one-off on dtstart; otherwise a bare RFC 5545 RRULE (allowlisted) */
  rrule?: string | null
  status?: PlanStatus
  notes?: string | null
}

export class PlanValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = "PlanValidationError"
  }
}

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

function monthOffset(baseIso: string, offset: number): string {
  const base = baseIso.slice(0, 7)
  const [y, m] = base.split("-").map(Number)
  const total = y * 12 + (m - 1) + offset
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}

/** Validate every provided field; returns exactly the keys that were provided. */
export function validatePlanInput(
  input: Record<string, unknown>
): Partial<PlanInput> {
  const out: Partial<PlanInput> = {}

  if ("amountCents" in input) {
    const v = input.amountCents
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v === 0) {
      throw new PlanValidationError(
        "amount must be a non-zero safe integer of cents",
        "invalid_amount"
      )
    }
    out.amountCents = v
  }

  if ("dtstart" in input) {
    // dtstart is not clearable (NOT NULL column) — an explicit null is as
    // invalid as any other non-date value, never a silent no-op that reads
    // back as a successful update
    const v = input.dtstart
    if (
      typeof v !== "string" ||
      !isValidIsoDate(v) ||
      Number.parseInt(v.slice(0, 4), 10) < MIN_DTSTART_YEAR
    ) {
      throw new PlanValidationError(
        `dtstart must be an ISO date (YYYY-MM-DD) from ${MIN_DTSTART_YEAR}-01-01 onward`,
        "invalid_dtstart"
      )
    }
    out.dtstart = v
  }

  if ("rrule" in input) {
    const v = input.rrule
    if (
      v === null ||
      typeof v === "undefined" ||
      (typeof v === "string" && isEmptyRule(v))
    ) {
      out.rrule = null
    } else if (typeof v === "string") {
      try {
        out.rrule = validateRrule(v)
      } catch (err) {
        if (err instanceof RuleValidationError) {
          throw new PlanValidationError(err.message, "invalid_rrule")
        }
        throw err
      }
    } else {
      throw new PlanValidationError(
        "rrule must be a string or null",
        "invalid_rrule"
      )
    }
  }

  if ("status" in input) {
    const v = input.status
    if (v !== "active" && v !== "paused" && v !== "finished") {
      throw new PlanValidationError(
        "status must be active|paused|finished",
        "invalid_status"
      )
    }
    out.status = v
  }

  for (const [key, max, code] of [
    ["counterparty", MAX_COUNTERPARTY, "invalid_counterparty"],
    ["purpose", MAX_TEXT, "invalid_purpose"],
    ["notes", MAX_TEXT, "invalid_notes"],
  ] as const) {
    if (key in input) {
      const v = input[key]
      if (v === null || typeof v === "undefined") {
        ;(out as Record<string, unknown>)[key] = null
      } else if (typeof v === "string") {
        const trimmed = normalizeWhitespace(v)
        if (Buffer.byteLength(trimmed, "utf8") > max) {
          throw new PlanValidationError(`too long (max ${max} bytes)`, code)
        }
        ;(out as Record<string, unknown>)[key] = trimmed === "" ? null : trimmed
      } else {
        throw new PlanValidationError("must be a string or null", code)
      }
    }
  }

  if ("accountId" in input) {
    out.accountId = normalizeOptionalId(input.accountId)
  }
  if ("categoryId" in input) {
    out.categoryId = normalizeOptionalId(input.categoryId)
  }
  return out
}

function normalizeOptionalId(v: unknown): number | null {
  if (v === null || typeof v === "undefined" || v === "") return null
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v
  if (typeof v === "string" && /^\d+$/.test(v)) return Number.parseInt(v, 10)
  throw new PlanValidationError("invalid id", "invalid_reference")
}

/** Ensure an optional referenced id exists and belongs to the user. */
function assertOwnedRef(
  table: typeof accounts | typeof categories,
  id: number | null | undefined,
  userId: number,
  code: string
) {
  if (id === null || id === undefined) return
  const row = getDb()
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.userId, userId)))
    .get()
  if (!row) {
    throw new PlanValidationError("referenced row does not exist", code)
  }
}

/**
 * A validated rule must produce at least one occurrence at/after dtstart.
 * The check walks the same bounded horizon ladder as nextOccurrenceDate
 * (closing rung ≥ the Gregorian 400-year cycle) instead of a fixed short
 * window: sparse-but-live rules (leap-day yearly, large INTERVAL) must be
 * creatable even when their first occurrence lies years ahead, while
 * genuinely dead rules (expired UNTIL, exhausted COUNT) still fail all
 * five bounded scans.
 */
function assertRuleProducesOccurrence(
  dtstart: string,
  rruleText: string | null
) {
  if (isEmptyRule(rruleText)) return
  if (nextOccurrenceDate(dtstart, rruleText, dtstart) === null) {
    throw new PlanValidationError(
      "rrule produces no occurrence at or after dtstart",
      "invalid_rrule"
    )
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export interface PlanRow {
  id: string
  accountId: number | null
  accountName: string | null
  counterparty: string | null
  purpose: string | null
  amountCents: number
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  dtstart: string
  rrule: string | null
  status: PlanStatus
  notes: string | null
  createdAt: string
  updatedAt: string
}

function planRowsQuery() {
  const db = getDb()
  return db
    .select({
      id: plannedTransactions.id,
      accountId: plannedTransactions.accountId,
      accountName: accounts.name,
      counterparty: plannedTransactions.counterparty,
      purpose: plannedTransactions.purpose,
      amountCents: plannedTransactions.amountCents,
      categoryId: plannedTransactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      dtstart: plannedTransactions.dtstart,
      rrule: plannedTransactions.rrule,
      status: plannedTransactions.status,
      notes: plannedTransactions.notes,
      createdAt: plannedTransactions.createdAt,
      updatedAt: plannedTransactions.updatedAt,
    })
    .from(plannedTransactions)
    .leftJoin(accounts, eq(accounts.id, plannedTransactions.accountId))
    .leftJoin(categories, eq(categories.id, plannedTransactions.categoryId))
}

export function listPlans(userId: number): PlanRow[] {
  return planRowsQuery()
    .where(eq(plannedTransactions.userId, userId))
    .orderBy(sql`${plannedTransactions.createdAt} DESC`)
    .all()
}

export function getPlan(userId: number, planId: string): PlanRow | null {
  return (
    planRowsQuery()
      .where(
        and(
          eq(plannedTransactions.id, planId),
          eq(plannedTransactions.userId, userId)
        )
      )
      .get() ?? null
  )
}

/** Next occurrence strictly in the future (today included), null for finished plans. */
export function nextDueDate(
  plan: Pick<PlanRow, "dtstart" | "rrule" | "status">,
  today: string
): string | null {
  if (plan.status === "finished") return null
  return nextOccurrenceDate(plan.dtstart, plan.rrule, today)
}

export function createPlan(
  userId: number,
  input: Record<string, unknown>
): PlanRow {
  const validated = validatePlanInput(input)
  if (validated.amountCents === undefined || validated.dtstart === undefined) {
    throw new PlanValidationError(
      "amount and dtstart are required",
      "invalid_plan"
    )
  }
  assertOwnedRef(
    accounts,
    validated.accountId ?? null,
    userId,
    "account_not_found"
  )
  assertOwnedRef(
    categories,
    validated.categoryId ?? null,
    userId,
    "category_not_found"
  )
  assertRuleProducesOccurrence(validated.dtstart, validated.rrule ?? null)

  const db = getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(plannedTransactions)
    .values({
      id,
      userId,
      counterparty: validated.counterparty ?? null,
      purpose: validated.purpose ?? null,
      amountCents: validated.amountCents,
      accountId: validated.accountId ?? null,
      categoryId: validated.categoryId ?? null,
      dtstart: validated.dtstart,
      rrule: validated.rrule ?? null,
      status: validated.status ?? "active",
      notes: validated.notes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const row = getPlan(userId, id)
  if (!row) {
    throw new PlanValidationError("could not create plan", "insert_failed")
  }
  return row
}

export function updatePlan(
  userId: number,
  planId: string,
  input: Record<string, unknown>
): PlanRow | null {
  const db = getDb()
  const existing = getPlan(userId, planId)
  if (!existing) return null
  const validated = validatePlanInput(input)
  // a body naming no known field would otherwise 200 with only an updatedAt
  // bump — indistinguishable from a successful edit
  if (Object.keys(validated).length === 0) {
    throw new PlanValidationError(
      "no updatable fields provided",
      "invalid_plan"
    )
  }
  assertOwnedRef(accounts, validated.accountId, userId, "account_not_found")
  assertOwnedRef(categories, validated.categoryId, userId, "category_not_found")
  const nextDtstart = validated.dtstart ?? existing.dtstart
  // a rule or dtstart change must still yield ≥ 1 occurrence — check against
  // the EFFECTIVE combination: the patched rrule wins even when it nulls the
  // rule (null = one-off on nextDtstart, which needs no occurrence check)
  const effectiveRrule =
    "rrule" in validated ? (validated.rrule ?? null) : existing.rrule
  if ("rrule" in validated || validated.dtstart !== undefined) {
    assertRuleProducesOccurrence(nextDtstart, effectiveRrule)
  }
  db.update(plannedTransactions)
    .set({
      ...(validated as Partial<typeof plannedTransactions.$inferInsert>),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(plannedTransactions.id, planId),
        eq(plannedTransactions.userId, userId)
      )
    )
    .run()
  return getPlan(userId, planId)
}

export function deletePlan(userId: number, planId: string): boolean {
  const db = getDb()
  const result = db
    .delete(plannedTransactions)
    .where(
      and(
        eq(plannedTransactions.id, planId),
        eq(plannedTransactions.userId, userId)
      )
    )
    .run()
  return result.changes > 0
}

// ── occurrences ───────────────────────────────────────────────────────────

export interface PlanOccurrence {
  /** stable occurrence key: `${planId}::${date}` */
  id: string
  planId: string
  date: string
  amountCents: number
  counterparty: string | null
  purpose: string | null
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  accountId: number | null
  /** active | paused — paused occurrences still expand (UI greys them) */
  planStatus: "active" | "paused"
  matched: {
    transactionId: string
    bookingDate: string
    amountCents: number
  } | null
}

/**
 * Expanded occurrences in [from, to] with read-time matching against booked
 * transactions (see lib/planning/matching.ts). The transaction candidate
 * window is padded by the match tolerances so posting drift across the
 * window edge still matches. Paused plans expand; finished ones do not.
 */
export function listOccurrences(
  userId: number,
  w: { from: string; to: string },
  accountId?: number | undefined
): PlanOccurrence[] {
  const db = getDb()
  const conditions: (SQL | undefined)[] = [
    eq(plannedTransactions.userId, userId),
    inArray(plannedTransactions.status, ["active", "paused"]),
  ]
  if (accountId !== undefined) {
    // the account filter also keeps account-agnostic plans visible
    conditions.push(
      sql`(${plannedTransactions.accountId} IS NULL OR ${plannedTransactions.accountId} = ${accountId})`
    )
  }
  const plans = db
    .select()
    .from(plannedTransactions)
    .where(and(...conditions))
    .all()

  const occurrences: PlanOccurrence[] = []
  const rowsById = new Map<string, (typeof plans)[number]>()
  for (const plan of plans) {
    rowsById.set(plan.id, plan)
    const dates = expandOccurrenceDates(plan.dtstart, plan.rrule, w)
    for (const date of dates) {
      occurrences.push({
        id: `${plan.id}::${date}`,
        planId: plan.id,
        date,
        amountCents: plan.amountCents,
        counterparty: plan.counterparty,
        purpose: plan.purpose,
        categoryId: plan.categoryId,
        categoryName: null,
        categoryColor: null,
        accountId: plan.accountId,
        planStatus: plan.status as "active" | "paused",
        matched: null,
      })
    }
  }
  if (occurrences.length === 0) return []

  occurrences.sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
  )
  enrichWithCategories(occurrences, userId)
  enrichWithMatches(occurrences, userId, accountId, w)
  return occurrences
}

/**
 * Resolve occurrence category names/colors — user-scoped like every other
 * read: category ids are globally unique, but scoping keeps the
 * enrichment dependent on the write-path ownership guarantees alone.
 */
function enrichWithCategories(occurrences: PlanOccurrence[], userId: number) {
  const db = getDb()
  const ids = [
    ...new Set(
      occurrences
        .map((o) => o.categoryId)
        .filter((id): id is number => id !== null)
    ),
  ]
  if (ids.length === 0) return
  const rows = db
    .select({
      id: categories.id,
      name: categories.name,
      color: categories.color,
    })
    .from(categories)
    .where(and(inArray(categories.id, ids), eq(categories.userId, userId)))
    .all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const o of occurrences) {
    if (o.categoryId === null) continue
    const cat = byId.get(o.categoryId)
    if (cat) {
      o.categoryName = cat.name
      o.categoryColor = cat.color
    }
  }
}

function enrichWithMatches(
  occurrences: PlanOccurrence[],
  userId: number,
  accountId: number | undefined,
  w: { from: string; to: string }
) {
  const db = getDb()
  const txFrom = isoDatePlus(w.from, -MATCH_DAYS_BEFORE)
  const txTo = isoDatePlus(w.to, MATCH_DAYS_AFTER)
  const conditions: SQL[] = [
    eq(transactions.userId, userId),
    eq(transactions.status, "Gebucht"),
    sql`${transactions.bookingDate} >= ${txFrom}`,
    sql`${transactions.bookingDate} <= ${txTo}`,
  ]
  if (accountId !== undefined) {
    conditions.push(eq(transactions.accountId, accountId))
  }
  const rows: MatchCandidate[] = db
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      amountCents: transactions.amountCents,
      payer: transactions.payer,
      payee: transactions.payee,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .where(and(...conditions))
    .all()

  const matchables: MatchableOccurrence[] = occurrences.map((o) => ({
    occurrenceKey: o.id,
    date: o.date,
    amountCents: o.amountCents,
    counterparty: o.counterparty,
    accountId: o.accountId,
  }))
  const txById = new Map(
    rows.map((r) => [
      r.id,
      {
        transactionId: r.id,
        bookingDate: r.bookingDate,
        amountCents: r.amountCents,
      },
    ])
  )
  // occurrence-key → row: O(1) per match instead of a scan
  // (the occurrence count is unbounded across plans × window size)
  const occurrencesById = new Map(occurrences.map((o) => [o.id, o]))
  for (const m of matchPlannedOccurrences(matchables, rows)) {
    const occurrence = occurrencesById.get(m.occurrenceKey)
    if (occurrence) occurrence.matched = txById.get(m.transactionId) ?? null
  }
}

// ── forecast ──────────────────────────────────────────────────────────────

interface BalanceAnchor {
  snapshotDate: string
  snapshotAmountCents: number
}

export interface ForecastResult {
  startingBalanceCents: number
  /** true when no snapshot exists → balance is Σ(booked) only */
  withoutSnapshot: boolean
  today: string
  horizon: { from: string; to: string }
  /** planned sums per month, calendar-ascending (netCents = income − expenses) */
  monthlyPlanned: Array<{
    month: string
    incomeCents: number
    expensesCents: number
    netCents: number
  }>
  /** balance projection points: today, then each day with movement, ascending */
  projectedBalance: Array<{ date: string; balanceCents: number }>
  /** planned expense totals per category over the horizon (income excluded) */
  plannedCategories: Array<{
    categoryId: number | null
    name: string
    color: string | null
    totalCents: number
    share: number
  }>
}

/**
 * The forecast is the third analytics scope (ADR-0035): the current balance
 * (real data, snapshot-anchored like engine.ts) plus planned occurrences
 * from today through `months` months — real bank amounts never enter the
 * projected sums, and projected amounts never enter the real analytics.
 *
 * Known limitation, inherited from the anchor math it mirrors: the anchor
 * is the SINGLE latest snapshot batch, so for an all-accounts projection
 * of a user whose accounts carry per-account snapshots only that one
 * account's snapshot money enters the starting balance (the Σ booked term
 * is all-account, the anchor is not) — like the analytics balance KPI.
 * Account-scoped forecasts are exact; withoutSnapshot flags the
 * snapshot-free case. If this matters, anchor per latest snapshot DATE
 * across the scoped batches.
 */
export function computeForecast(
  userId: number,
  options: { months?: number; accountId?: number; today?: string } = {}
): ForecastResult {
  const db = getDb()
  const months =
    typeof options.months === "number" &&
    Number.isInteger(options.months) &&
    options.months >= 1
      ? Math.min(options.months, MAX_FORECAST_MONTHS)
      : 12
  const accountId =
    typeof options.accountId === "number" &&
    Number.isInteger(options.accountId) &&
    options.accountId > 0
      ? options.accountId
      : undefined
  const today = options.today ?? todayLocal()
  const horizonEnd = lastDayOfMonth(monthOffset(today, months - 1))

  // ── current balance: snapshot-anchored, mirrors lib/analytics/engine.ts ──
  const anchorWhere =
    accountId !== undefined
      ? and(
          eq(importBatches.userId, userId),
          eq(importBatches.accountId, accountId)
        )
      : eq(importBatches.userId, userId)
  const anchors = db
    .select({
      snapshotDate: importBatches.snapshotDate,
      snapshotAmountCents: importBatches.snapshotAmountCents,
    })
    .from(importBatches)
    .where(anchorWhere)
    .all()
    .filter(
      (r): r is { snapshotDate: string; snapshotAmountCents: number } =>
        r.snapshotDate !== null &&
        r.snapshotAmountCents !== null &&
        r.snapshotDate <= today
    )
  const anchor = anchors.reduce<BalanceAnchor | null>(
    (latest, r) =>
      latest === null || r.snapshotDate > latest.snapshotDate ? r : latest,
    null
  )

  const bookedWhere =
    accountId !== undefined
      ? and(
          eq(transactions.userId, userId),
          eq(transactions.status, "Gebucht"),
          eq(transactions.accountId, accountId)
        )
      : and(eq(transactions.userId, userId), eq(transactions.status, "Gebucht"))

  let startingBalanceCents: number
  let withoutSnapshot: boolean
  if (anchor !== null) {
    withoutSnapshot = false
    const sumAfter = Number(
      db
        .select({
          sum: sql<string>`COALESCE(SUM(${transactions.amountCents}), 0)`,
        })
        .from(transactions)
        .where(
          and(
            bookedWhere,
            sql`${transactions.bookingDate} > ${anchor.snapshotDate}`,
            sql`${transactions.bookingDate} <= ${today}`
          )
        )
        .get()?.sum ?? "0"
    )
    startingBalanceCents = anchor.snapshotAmountCents + sumAfter
  } else {
    withoutSnapshot = true
    const sumUpToToday = Number(
      db
        .select({
          sum: sql<string>`COALESCE(SUM(${transactions.amountCents}), 0)`,
        })
        .from(transactions)
        .where(and(bookedWhere, sql`${transactions.bookingDate} <= ${today}`))
        .get()?.sum ?? "0"
    )
    startingBalanceCents = sumUpToToday
  }

  // ── planned occurrences over the horizon ──
  const occurrences = listOccurrences(
    userId,
    { from: today, to: horizonEnd },
    accountId
  )

  const monthlyPlanned = new Map<
    string,
    { incomeCents: number; expensesCents: number }
  >()
  const plannedByDate = new Map<string, number>()
  const catTotals = new Map<number | null, number>()
  let totalPlannedExpenses = 0
  for (const o of occurrences) {
    // MATCHED occurrences are real money already — they sit in the booked
    // history and would double-count the forecast (planned = not-yet-booked).
    // Horizon edge: a match whose booking posts AFTER horizonEnd is not part
    // of this projection at all (starting balance stops at today, realFuture
    // at horizonEnd), so the planned occurrence remains its only in-horizon
    // representation and stays counted. bookingDate ≤ horizonEnd is what
    // makes "already booked" true within this projection: ≤ today sits in
    // the starting balance, > today in the realFuture sum.
    if (o.matched !== null && o.matched.bookingDate <= horizonEnd) continue
    const month = o.date.slice(0, 7)
    const entry = monthlyPlanned.get(month) ?? {
      incomeCents: 0,
      expensesCents: 0,
    }
    if (o.amountCents > 0) {
      entry.incomeCents += o.amountCents
    } else {
      entry.expensesCents += -o.amountCents
      catTotals.set(
        o.categoryId,
        (catTotals.get(o.categoryId) ?? 0) + -o.amountCents
      )
      totalPlannedExpenses += -o.amountCents
    }
    monthlyPlanned.set(month, entry)
    plannedByDate.set(o.date, (plannedByDate.get(o.date) ?? 0) + o.amountCents)
  }

  // ── real future bookings (already imported, booked AFTER today) also move
  // the projected balance — they are certain money, unlike the plans
  const realFutureRows = db
    .select({
      date: transactions.bookingDate,
      sum: sql<string>`SUM(${transactions.amountCents})`,
    })
    .from(transactions)
    .where(
      and(
        bookedWhere,
        sql`${transactions.bookingDate} > ${today}`,
        sql`${transactions.bookingDate} <= ${horizonEnd}`
      )
    )
    .groupBy(transactions.bookingDate)
    .all()
  const realFuture = new Map(realFutureRows.map((r) => [r.date, Number(r.sum)]))

  // ── projected timeline: today's point, then every day with movement ──
  const projectedBalance: Array<{ date: string; balanceCents: number }> = []
  projectedBalance.push({
    date: today,
    balanceCents: startingBalanceCents + (plannedByDate.get(today) ?? 0),
  })
  const movementDates = [
    ...new Set([...plannedByDate.keys(), ...realFuture.keys()]),
  ].sort()
  let running = startingBalanceCents + (plannedByDate.get(today) ?? 0)
  for (const date of movementDates) {
    if (date === today) continue // already folded into the starting point
    running += (plannedByDate.get(date) ?? 0) + (realFuture.get(date) ?? 0)
    projectedBalance.push({ date, balanceCents: running })
  }

  // ── planned expenses per category ──
  const catIds = [
    ...new Set([...catTotals.keys()].filter((id): id is number => id !== null)),
  ]
  const catRows = catIds.length
    ? db
        .select({
          id: categories.id,
          name: categories.name,
          color: categories.color,
        })
        .from(categories)
        .where(
          and(inArray(categories.id, catIds), eq(categories.userId, userId))
        )
        .all()
    : []
  const catById = new Map(catRows.map((r) => [r.id, r]))
  const plannedCategories = [...catTotals.entries()]
    .map(([categoryId, totalCents]) => {
      const cat = categoryId === null ? null : catById.get(categoryId)
      return {
        categoryId,
        name: cat?.name ?? "ohne Kategorie",
        color: cat?.color ?? null,
        totalCents,
        share: totalPlannedExpenses > 0 ? totalCents / totalPlannedExpenses : 0,
      }
    })
    .sort((a, b) => b.totalCents - a.totalCents)

  return {
    startingBalanceCents,
    withoutSnapshot,
    today,
    horizon: { from: today, to: horizonEnd },
    monthlyPlanned: [...monthlyPlanned.entries()]
      .map(([month, v]) => ({
        month,
        incomeCents: v.incomeCents,
        expensesCents: v.expensesCents,
        netCents: v.incomeCents - v.expensesCents,
      }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    projectedBalance,
    plannedCategories,
  }
}
