/**
 * Dataset loading for the automatic daily prediction model.
 *
 * Reads booked transactions, removes transactions already represented by an
 * active plan (via the shared read-time matcher), and produces the daily
 * residual series the model trains on. All reads are user-scoped.
 */
import { createHash } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { getDb } from "@/lib/db"
import {
  accounts,
  categories,
  plannedTransactions,
  transactions,
} from "@/lib/db/schema"
import { buildTimeScopedWhere } from "@/lib/analytics/balance"
import {
  isoDatePlus,
  isValidIsoDate,
  lastDayOfMonthIso,
  MAX_MONTH_KEY,
  monthOffset,
  todayLocal,
} from "@/lib/dates"
import { listOccurrences } from "@/lib/planning/service"
import { MATCH_DAYS_AFTER, MATCH_DAYS_BEFORE } from "@/lib/planning/limits"
import {
  MAX_TRAINING_DAYS,
  PREDICTION_HORIZON_MONTHS,
} from "@/lib/prediction/limits"
import type { DailySeriesPoint } from "@/lib/prediction/types"

export interface ScopeTransactionRow {
  id: string
  bookingDate: string
  amountCents: number
}

export interface DailyDataset {
  series: DailySeriesPoint[]
  /** booked rows read; includes matched/zero rows excluded from the series */
  transactionCount: number
  planSignature: string
  dataSignature: string
  /** transaction ids already represented by an active plan */
  matchedTransactionIds: Set<string>
}

export interface CategoryShare {
  categoryId: number | null
  name: string
  color: string | null
  share: number
}

export interface FutureBookedDay {
  expenseCents: number
  incomeCents: number
}

function daysBetweenInclusive(from: string, to: string): string[] {
  const days: string[] = []
  let cursor = from
  while (cursor <= to) {
    days.push(cursor)
    const next = isoDatePlus(cursor, 1)
    if (next === cursor) break
    cursor = next
  }
  return days
}

/** Active plan rows that apply to a scope, in a deterministic order. */
export function applicableActivePlans(
  userId: number,
  accountId: number | null
) {
  const db = getDb()
  const conditions: SQL[] = [
    eq(plannedTransactions.userId, userId),
    eq(plannedTransactions.status, "active"),
  ]
  if (accountId !== null) {
    conditions.push(
      sql`(${plannedTransactions.accountId} IS NULL OR ${plannedTransactions.accountId} = ${accountId})`
    )
  }
  return db
    .select()
    .from(plannedTransactions)
    .where(and(...conditions))
    .all()
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Stable signature of the active-plan inputs that shape the residual. */
export function computePlanSignature(
  userId: number,
  accountId: number | null
): string {
  const plans = applicableActivePlans(userId, accountId)
  const payload = JSON.stringify(
    plans.map((plan) => [
      plan.id,
      plan.amountCents,
      plan.dtstart,
      plan.rrule ?? null,
      plan.counterparty ?? null,
      plan.accountId ?? null,
    ])
  )
  return createHash("sha256").update(payload).digest("hex")
}

/** Transaction ids already claimed by an active plan occurrence. */
function matchedTransactionIds(
  userId: number,
  accountId: number | null,
  from: string,
  to: string
): Set<string> {
  if (from > to) return new Set()
  // Expand the plan occurrence window by the same posting tolerances the
  // matcher uses, so a due-tomorrow plan can claim today's booking in the
  // residual exactly like it does in the forecast.
  const paddedFrom = isoDatePlus(from, -MATCH_DAYS_BEFORE)
  const paddedTo = isoDatePlus(to, MATCH_DAYS_AFTER)
  const occurrences = listOccurrences(
    userId,
    {
      from: isValidIsoDate(paddedFrom) ? paddedFrom : from,
      to: isValidIsoDate(paddedTo) ? paddedTo : to,
    },
    accountId ?? undefined,
    { includePaused: false }
  )
  const ids = new Set<string>()
  for (const occurrence of occurrences) {
    if (occurrence.matched) ids.add(occurrence.matched.transactionId)
  }
  return ids
}

/**
 * Load the daily residual series for a scope.
 *
 * `today` is the inclusive end of the training window. Transactions matched
 * to an active plan are removed from both directions; plans are added back
 * deterministically at forecast time.
 */
export function loadDailyDataset(
  userId: number,
  accountId: number | null,
  today: string = todayLocal()
): DailyDataset | null {
  const db = getDb()
  const from = isoDatePlus(today, -(MAX_TRAINING_DAYS - 1))
  const rows = db
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      buildTimeScopedWhere(userId, accountId ?? undefined, {
        from,
        to: today,
      })
    )
    .all() as ScopeTransactionRow[]

  if (rows.length === 0) return null
  const planSignature = computePlanSignature(userId, accountId)
  const matched = matchedTransactionIds(userId, accountId, from, today)

  const byDate = new Map<string, { expense: number; income: number }>()
  for (const row of rows) {
    if (matched.has(row.id)) continue
    const entry = byDate.get(row.bookingDate) ?? { expense: 0, income: 0 }
    if (row.amountCents < 0) entry.expense += -row.amountCents
    else if (row.amountCents > 0) entry.income += row.amountCents
    byDate.set(row.bookingDate, entry)
  }

  const first = rows.reduce(
    (min, row) => (row.bookingDate < min ? row.bookingDate : min),
    rows[0].bookingDate
  )
  const last = rows.reduce(
    (max, row) => (row.bookingDate > max ? row.bookingDate : max),
    rows[0].bookingDate
  )
  const series: DailySeriesPoint[] = daysBetweenInclusive(first, last).map(
    (date) => {
      const entry = byDate.get(date)
      return {
        date,
        expenseCents: entry?.expense ?? 0,
        incomeCents: entry?.income ?? 0,
      }
    }
  )

  const accountIds =
    accountId === null
      ? db
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.userId, userId))
          .all()
          .map((row) => row.id)
          .sort((a, b) => a - b)
      : [accountId]
  const signaturePayload = [
    first,
    last,
    series
      .map((point) => `${point.expenseCents}/${point.incomeCents}`)
      .join(","),
    planSignature,
    accountIds.join(","),
  ].join("|")
  const dataSignature = createHash("sha256")
    .update(signaturePayload)
    .digest("hex")

  return {
    series,
    transactionCount: rows.length,
    planSignature,
    dataSignature,
    matchedTransactionIds: matched,
  }
}

/** Daily totals for already-booked rows after today (certain future money). */
export function loadFutureBooked(
  userId: number,
  accountId: number | null,
  today: string,
  horizonEnd: string
): Map<string, FutureBookedDay> {
  const db = getDb()
  const result = new Map<string, FutureBookedDay>()
  const detail = db
    .select({
      date: transactions.bookingDate,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      buildTimeScopedWhere(userId, accountId ?? undefined, {
        after: today,
        to: horizonEnd,
      })
    )
    .all()
  for (const row of detail) {
    if (row.amountCents === 0) continue
    const entry = result.get(row.date) ?? { expenseCents: 0, incomeCents: 0 }
    if (row.amountCents < 0) entry.expenseCents += -row.amountCents
    else entry.incomeCents += row.amountCents
    result.set(row.date, entry)
  }
  return result
}

/** Latest booked expense/category shares over the last 90 days. */
export function loadCategoryShares(
  userId: number,
  accountId: number | null,
  today: string,
  excludedTransactionIds?: ReadonlySet<string>
): CategoryShare[] {
  const db = getDb()
  const from = isoDatePlus(today, -89)
  const rows = db
    .select({
      id: transactions.id,
      categoryId: transactions.categoryId,
      amountCents: transactions.amountCents,
    })
    .from(transactions)
    .where(
      buildTimeScopedWhere(userId, accountId ?? undefined, {
        from,
        to: today,
      })
    )
    .all()
  const totals = new Map<number | null, number>()
  for (const row of rows) {
    if (row.amountCents >= 0) continue
    if (excludedTransactionIds?.has(row.id)) continue
    totals.set(
      row.categoryId,
      (totals.get(row.categoryId) ?? 0) + -row.amountCents
    )
  }
  const ids = [...totals.keys()].filter((id): id is number => id !== null)
  const known = new Map(
    (ids.length
      ? db
          .select({
            id: categories.id,
            name: categories.name,
            color: categories.color,
          })
          .from(categories)
          .where(
            and(eq(categories.userId, userId), inArray(categories.id, ids))
          )
          .all()
      : []
    ).map((category) => [category.id, category])
  )
  const grand = [...totals.values()].reduce((sum, value) => sum + value, 0)
  if (grand <= 0) return []
  return [...totals.entries()]
    .map(([categoryId, total]) => {
      const category = categoryId === null ? null : known.get(categoryId)
      return {
        categoryId,
        name: category?.name ?? "ohne Kategorie",
        color: category?.color ?? null,
        share: total / grand,
      }
    })
    .sort((a, b) => b.share - a.share)
}

/** First day after today and the end of the chart horizon. */
export function predictionWindow(today: string): {
  from: string
  to: string
} {
  const next = isoDatePlus(today, 1)
  const start = isValidIsoDate(next) ? next : today
  let endMonth: string
  try {
    endMonth = monthOffset(today, PREDICTION_HORIZON_MONTHS - 1)
  } catch {
    // a caller-supplied today at the storable ceiling cannot move the
    // horizon forward; clamp to the last representable month instead
    endMonth = MAX_MONTH_KEY
  }
  return {
    from: start,
    to: lastDayOfMonthIso(endMonth),
  }
}
