import { and, eq, gt, gte, lt, lte, sql, type SQL } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches, transactions } from "@/lib/db/schema"
import { buildWhere, type TransactionFilters } from "@/lib/analytics/queries"

export interface MonthlyCashflowPoint {
  month: string // YYYY-MM
  incomeCents: number
  expensesCents: number
  netCents: number
}

export interface BalancePoint {
  date: string
  balanceCents: number
}

export interface TopCategoryPoint {
  categoryId: number | null
  name: string // 'Unlabeled' bucket for null categories
  /** stored permanent color (null for the Unlabeled bucket / legacy rows) */
  color: string | null
  totalCents: number
  share: number
  txCount: number
}

export interface SavingsHistory {
  /** last COMPLETE month (YYYY-MM) the series ends at */
  lastMonth: string
  lastMonthNetCents: number
  /**
   * true when lastMonth is not the previous calendar month, i.e. imports
   * stopped after lastMonth — the UI can mark the headline as stale
   */
  lastMonthIsStale: boolean
  /** zero-filled window of the 6 months ending at lastMonth */
  months: MonthlyCashflowPoint[]
  /**
   * the still-running month, if it has any bookings. Provided separately
   * so the UI can mark it as incomplete; NOT part of months.
   */
  currentMonth: MonthlyCashflowPoint | null
}

export interface AnalyticsResult {
  kpis: {
    currentBalanceCents: number | null
    /** true when no snapshot exists → balance is Σ(booked) only */
    balanceWithoutSnapshot: boolean
    avgMonthlyIncomeCents: number | null
    avgMonthlyExpensesCents: number | null
    savingsRate: number | null
    transactionCount: number
    monthsCounted: number
  }
  monthlyCashflow: MonthlyCashflowPoint[]
  balanceTimeline: BalancePoint[]
  topCategories: TopCategoryPoint[]
  savingsHistory: SavingsHistory | null
}

interface BalanceAnchor {
  snapshotDate: string
  snapshotAmountCents: number
}

/**
 * There are two filter scopes, kept separate by construction:
 *
 * 1. **Flow scope** — cashflow, categories, transaction count. Reacts to
 *    every filter including `status` (via `buildWhere`, shared with the
 *    transactions table).
 * 2. **Time-scoped scope** — balance (KPI + timeline) and savings history.
 *    Snapshots anchor an *absolute booked* account balance, so every content
 *    filter is structurally out of scope: these aggregates are built from an
 *    allowlist (`buildTimeScopedWhere`: user, booked rows, optional account,
 *    caller-supplied date bounds), never by stripping fields off the flow
 *    filters — a new filter added to `TransactionFilters` cannot leak here.
 */
function buildTimeScopedWhere(
  userId: number,
  accountId: number | undefined,
  dateBounds?: { from?: string; to?: string }
): SQL | undefined {
  const conditions: SQL[] = [
    eq(transactions.userId, userId),
    eq(transactions.status, "Gebucht"),
  ]
  if (accountId !== undefined) {
    conditions.push(eq(transactions.accountId, accountId))
  }
  if (dateBounds?.from !== undefined) {
    conditions.push(gte(transactions.bookingDate, dateBounds.from))
  }
  if (dateBounds?.to !== undefined) {
    conditions.push(lte(transactions.bookingDate, dateBounds.to))
  }
  return and(...conditions)
}

/**
 * Balance anchor = LATEST snapshot across all batches (most recent known
 * absolute balance point). Current balance = snapshot + Σ(booked amounts
 * with booking_date > snapshot_date) — robust to missing older history.
 */
function latestAnchor(
  userId: number,
  accountId?: number
): BalanceAnchor | null {
  const db = getDb()
  const rows = db
    .select({
      snapshotDate: importBatches.snapshotDate,
      snapshotAmountCents: importBatches.snapshotAmountCents,
    })
    .from(importBatches)
    .where(
      accountId !== undefined
        ? and(
            eq(importBatches.userId, userId),
            eq(importBatches.accountId, accountId),
            sql`${importBatches.snapshotDate} IS NOT NULL AND ${importBatches.snapshotAmountCents} IS NOT NULL`
          )
        : sql`${importBatches.userId} = ${userId} AND ${importBatches.snapshotDate} IS NOT NULL AND ${importBatches.snapshotAmountCents} IS NOT NULL`
    )
    .all()
  const valid = rows.filter(
    (r): r is { snapshotDate: string; snapshotAmountCents: number } =>
      r.snapshotDate !== null && r.snapshotAmountCents !== null
  )
  if (valid.length === 0) return null
  return valid.reduce((latest, r) =>
    r.snapshotDate > latest.snapshotDate ? r : latest
  )
}

function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** list of YYYY-MM between two ISO dates, inclusive, zero-filled */
function monthsBetween(fromIso: string, toIso: string): string[] {
  const months: string[] = []
  let [y, m] = fromIso.split("-").map(Number)
  const [ty, tm] = toIso.split("-").map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return months
}

/** day-of-month of the last calendar day of the month containing iso */
function lastDayOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number)
  return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")
}

/**
 * Flow aggregates (cashflow, categories, KPIs) react to every filter and
 * share buildWhere with the transactions table. Balance and savings are
 * time-scoped by design — see buildTimeScopedWhere.
 */
export function computeAnalytics(
  f: TransactionFilters,
  userId: number,
  today: string
): AnalyticsResult {
  const db = getDb()

  // ── flow aggregates: single filter source, shared with the table ──
  const flowWhere = buildWhere(f, userId)

  const monthlyRows = db
    .select({
      month: sql<string>`substr(${transactions.bookingDate}, 1, 7)`,
      income: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)`,
      expenses: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(transactions)
    .where(flowWhere)
    .groupBy(sql`substr(${transactions.bookingDate}, 1, 7)`)
    .all()
    .map((r) => ({
      month: r.month,
      income: Number(r.income),
      expenses: Number(r.expenses),
    }))

  const monthlyCashflow: MonthlyCashflowPoint[] = []
  let monthsCounted = 0
  let avgIncome: number | null = null
  let avgExpenses: number | null = null
  let savingsRate: number | null = null

  if (monthlyRows.length > 0) {
    const bounds = db
      .select({
        min: sql<string>`MIN(${transactions.bookingDate})`,
        max: sql<string>`MAX(${transactions.bookingDate})`,
      })
      .from(transactions)
      .where(flowWhere)
      .get()
    // bounds are inclusive (the DB predicates are gte/lte on booking_date)
    const minDate = f.dateFrom ?? bounds?.min ?? today
    const maxDate = f.dateTo ?? bounds?.max ?? today

    // partial current month: include in series, exclude from averages
    const currentMonth = monthOf(today)
    let lastFullMonth = monthOf(maxDate)
    if (lastFullMonth >= currentMonth) {
      lastFullMonth = prevMonth(currentMonth)
    } else if (
      f.dateTo !== undefined &&
      f.dateTo.slice(8, 10) !== lastDayOfMonth(f.dateTo)
    ) {
      // mid-month dateTo in a past month: that month is partial, not full
      lastFullMonth = prevMonth(lastFullMonth)
    }

    const spanStartMonth = monthOf(minDate)
    const allMonths = monthsBetween(spanStartMonth, monthOf(maxDate))

    // mid-month dateFrom: that month is partial, not full (mirrors dateTo)
    let firstFullMonth = spanStartMonth
    if (f.dateFrom !== undefined && f.dateFrom.slice(8, 10) !== "01") {
      firstFullMonth = nextMonth(firstFullMonth)
    }

    const byMonth = new Map(monthlyRows.map((r) => [r.month, r]))
    for (const m of allMonths) {
      const row = byMonth.get(m)
      const income = row?.income ?? 0
      const expenses = row?.expenses ?? 0
      monthlyCashflow.push({
        month: m,
        incomeCents: income,
        expensesCents: expenses,
        netCents: income - expenses,
      })
    }

    // averages over full months only (partial end months excluded)
    const fullMonths = allMonths.filter(
      (m) => m <= lastFullMonth && m >= firstFullMonth
    )
    monthsCounted = fullMonths.length
    const sumIncome = fullMonths.reduce(
      (acc, m) => acc + (byMonth.get(m)?.income ?? 0),
      0
    )
    const sumExpenses = fullMonths.reduce(
      (acc, m) => acc + (byMonth.get(m)?.expenses ?? 0),
      0
    )
    avgIncome = monthsCounted > 0 ? Math.round(sumIncome / monthsCounted) : null
    avgExpenses =
      monthsCounted > 0 ? Math.round(sumExpenses / monthsCounted) : null
    savingsRate =
      avgIncome !== null && avgIncome > 0
        ? (avgIncome - (avgExpenses ?? 0)) / avgIncome
        : null
  }

  // ── transaction count + top categories (flow scope) ───────────────
  const txCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(flowWhere)
      .get()?.count ?? 0

  const catRows = db
    .select({
      categoryId: transactions.categoryId,
      name: sql<string>`COALESCE(categories.name, '')`,
      color: sql<string | null>`categories.color`,
      total: sql<number>`COALESCE(SUM(-${transactions.amountCents}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(transactions)
    .leftJoin(sql`categories`, sql`${transactions.categoryId} = categories.id`)
    .where(and(flowWhere, sql`${transactions.amountCents} < 0`))
    .groupBy(transactions.categoryId)
    .orderBy(sql`SUM(-${transactions.amountCents}) DESC`)
    .all()
    .map((r) => ({
      ...r,
      total: Number(r.total),
      count: Number(r.count),
    }))

  const totalExpenses = catRows.reduce((acc, r) => acc + r.total, 0)
  const topCategories: TopCategoryPoint[] = catRows
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.categoryId === null ? "Unlabeled" : r.name,
      color: r.categoryId === null ? null : r.color,
      totalCents: r.total,
      share: totalExpenses > 0 ? r.total / totalExpenses : 0,
      txCount: r.count,
    }))
    .slice(0, 12)

  // ── savings history: last 6 complete months, time-scoped only ─────
  // Allowlist-built scope (user + booked + optional account): content
  // filters including status are structurally out of scope.
  const savingsWhere = buildTimeScopedWhere(userId, f.accountId)

  let savingsHistory: SavingsHistory | null = null

  // index seek instead of a full grouped scan: the latest booking month
  // alone decides whether the window ends at prevOfToday or earlier
  const latestBookingDate = db
    .select({ max: sql<string | null>`MAX(${transactions.bookingDate})` })
    .from(transactions)
    .where(savingsWhere)
    .get()?.max

  if (latestBookingDate != null) {
    const currentMonthKey = monthOf(today)
    const prevOfToday = prevMonth(currentMonthKey)
    const latestBookingMonth = latestBookingDate.slice(0, 7)
    // never claim a month that has no bookings yet (stale imports) and
    // never claim the still-running current month
    const lastCompleteMonth =
      prevOfToday < latestBookingMonth ? prevOfToday : latestBookingMonth
    const windowStart = (() => {
      let m = lastCompleteMonth
      for (let i = 0; i < 5; i++) m = prevMonth(m)
      return m
    })()

    // single bounded scan: the 6-month window plus the running month
    // (bookings dated after `today` inside later months are irrelevant)
    const rows = db
      .select({
        month: sql<string>`substr(${transactions.bookingDate}, 1, 7)`,
        income: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)`,
        expenses: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
      })
      .from(transactions)
      .where(
        and(
          savingsWhere,
          gte(transactions.bookingDate, `${windowStart}-01`),
          lt(transactions.bookingDate, `${nextMonth(currentMonthKey)}-01`)
        )
      )
      .groupBy(sql`substr(${transactions.bookingDate}, 1, 7)`)
      .all()
      .map((r) => ({
        month: r.month,
        income: Number(r.income),
        expenses: Number(r.expenses),
      }))

    const byMonth = new Map(rows.map((r) => [r.month, r]))
    const months = monthsBetween(windowStart, lastCompleteMonth).map((m) => {
      const row = byMonth.get(m)
      const income = row?.income ?? 0
      const expenses = row?.expenses ?? 0
      return {
        month: m,
        incomeCents: income,
        expensesCents: expenses,
        netCents: income - expenses,
      }
    })
    const last = months[months.length - 1]
    // an empty window (no bookings in [windowStart, lastCompleteMonth]) must
    // not crash: report zero net for the last complete month
    const lastMonthNetCents = last ? last.netCents : 0

    // the running month is appended separately (UI marks it incomplete)
    const currentRow = byMonth.get(currentMonthKey)
    const currentMonth: MonthlyCashflowPoint | null = currentRow
      ? {
          month: currentMonthKey,
          incomeCents: currentRow.income,
          expensesCents: currentRow.expenses,
          netCents: currentRow.income - currentRow.expenses,
        }
      : null

    savingsHistory = {
      lastMonth: lastCompleteMonth,
      lastMonthNetCents,
      // stale = the series does not reach the previous calendar month
      lastMonthIsStale: lastCompleteMonth < prevOfToday,
      months,
      currentMonth,
    }
  }

  // ── balance: snapshot anchor math, time-scoped only ───────────────
  const anchor = latestAnchor(userId, f.accountId)
  const { dateFrom, dateTo } = f

  // The backward reconstruction subtracts everything between a day and the
  // anchor, so it must see bookings up to max(dateTo, anchorDate) — clipping
  // at dateTo would mislabel the (dateTo, anchorDate] segment as zero.
  const reconDateTo =
    anchor !== null && dateTo !== undefined && dateTo < anchor.snapshotDate
      ? anchor.snapshotDate
      : dateTo
  const reconWhere = buildTimeScopedWhere(userId, f.accountId, {
    to: reconDateTo,
  })

  const dailyRows = db
    .select({
      date: transactions.bookingDate,
      sum: sql<number>`SUM(${transactions.amountCents})`,
    })
    .from(transactions)
    .where(reconWhere)
    .groupBy(transactions.bookingDate)
    .orderBy(transactions.bookingDate)
    .all()
    .map((r) => ({ date: r.date, sum: Number(r.sum) }))

  const series: BalancePoint[] = []

  if (anchor) {
    // DKB snapshots sit at the END of the export period, so earlier balances
    // are back-calculated: at every booked day d ≤ snapshot the balance is
    // snapshot − Σ(sums of booked days after d, up to and incl. snapshot day).
    const firstAfter = dailyRows.findIndex((r) => r.date > anchor.snapshotDate)
    const lastBeforeIdx = firstAfter === -1 ? dailyRows.length : firstAfter

    let suffix = 0
    const backward: BalancePoint[] = []
    for (let i = lastBeforeIdx - 1; i >= 0; i--) {
      const row = dailyRows[i]
      if (row.date !== anchor.snapshotDate) {
        backward.push({
          date: row.date,
          balanceCents: anchor.snapshotAmountCents - suffix,
        })
      }
      suffix += row.sum
    }
    backward.reverse()

    series.push(...backward, {
      date: anchor.snapshotDate,
      balanceCents: anchor.snapshotAmountCents,
    })

    let running = anchor.snapshotAmountCents
    for (
      let i = firstAfter === -1 ? dailyRows.length : firstAfter;
      i < dailyRows.length;
      i++
    ) {
      running += dailyRows[i].sum
      series.push({ date: dailyRows[i].date, balanceCents: running })
    }
  } else {
    // no snapshot: cumulative sum from zero (best-effort pseudo balance)
    let running = 0
    for (const row of dailyRows) {
      running += row.sum
      series.push({ date: row.date, balanceCents: running })
    }
  }

  // visible timeline = full series clipped to the requested [from, to] window
  let balanceTimeline = series
  if (dateFrom !== undefined) {
    const i = balanceTimeline.findIndex((p) => p.date >= dateFrom)
    balanceTimeline = i === -1 ? [] : balanceTimeline.slice(i)
  }
  if (dateTo !== undefined) {
    balanceTimeline = balanceTimeline.filter((p) => p.date <= dateTo)
  }

  // KPI: balance as of dateTo (or the latest known day), read from the
  // UNSLICED series so it survives an empty visible window
  let currentBalanceCents: number | null = null
  let balanceWithoutSnapshot: boolean
  let lastUpToDate: BalancePoint | null = null
  for (const p of series) {
    if (dateTo === undefined || p.date <= dateTo) lastUpToDate = p
    else break
  }

  if (anchor) {
    balanceWithoutSnapshot = false
    if (lastUpToDate !== null) {
      currentBalanceCents = lastUpToDate.balanceCents
    } else if (dateTo !== undefined) {
      // dateTo precedes every booking and the anchor: balance(dateTo) =
      // anchor − Σ(bookings in (dateTo, anchorDate]); reconWhere is already
      // clipped at the anchor here
      const gap =
        db
          .select({
            sum: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`,
          })
          .from(transactions)
          .where(and(reconWhere, gt(transactions.bookingDate, dateTo)))
          .get()?.sum ?? 0
      currentBalanceCents = anchor.snapshotAmountCents - Number(gap)
    }
  } else {
    balanceWithoutSnapshot = true
    if (lastUpToDate !== null) {
      currentBalanceCents = lastUpToDate.balanceCents
    }
  }

  return {
    kpis: {
      currentBalanceCents,
      balanceWithoutSnapshot,
      avgMonthlyIncomeCents: avgIncome,
      avgMonthlyExpensesCents: avgExpenses,
      savingsRate,
      transactionCount: txCount,
      monthsCounted,
    },
    monthlyCashflow,
    balanceTimeline,
    topCategories,
    savingsHistory,
  }
}

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  const ny = m === 1 ? y - 1 : y
  const nm = m === 1 ? 12 : m - 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}
