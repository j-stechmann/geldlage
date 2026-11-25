/**
 * Forecast composition for the daily prediction engine.
 *
 * The daily model produces an irregular-spending residual; active plans and
 * already-booked future rows are added on their exact dates. The result is
 * the chart-facing two-month envelope.
 */
import { computeStartingBalance } from "@/lib/analytics/balance"
import { isoDatePlus, monthOf, monthsBetween, todayLocal } from "@/lib/dates"
import type {
  PredictionCategoryPoint,
  PredictionDayPoint,
  PredictionForecast,
  PredictionMonthPoint,
} from "@/lib/contracts/prediction"
import { listOccurrences } from "@/lib/planning/service"
import {
  loadCategoryShares,
  loadDailyDataset,
  loadFutureBooked,
  predictionWindow,
} from "@/lib/prediction/dataset"
import { mean } from "@/lib/prediction/math"
import { MIN_TRAINING_DAYS } from "@/lib/prediction/limits"
import { predictDirection } from "@/lib/prediction/model"
import {
  loadPredictionModel,
  ownsAccount,
  predictionNextRetryAt,
} from "@/lib/prediction/service"
import { modelNeedsRefresh, scheduleIfStale } from "@/lib/prediction/scheduler"
import type {
  DailySeriesPoint,
  PredictionArtifact,
} from "@/lib/prediction/types"

export class PredictionScopeError extends Error {
  constructor(public readonly code: "invalid_account") {
    super(code)
    this.name = "PredictionScopeError"
  }
}

function assertScope(userId: number, accountId: number | null): void {
  if (accountId !== null && !ownsAccount(userId, accountId)) {
    throw new PredictionScopeError("invalid_account")
  }
}

function baselineRate(
  series: readonly DailySeriesPoint[],
  direction: "expense" | "income"
): number {
  const values = series
    .slice(Math.max(0, series.length - 30))
    .map((point) =>
      direction === "expense" ? point.expenseCents : point.incomeCents
    )
  return Math.max(0, mean(values))
}

function predictDay(
  artifact: PredictionArtifact | null,
  history: readonly DailySeriesPoint[],
  targetDate: string,
  direction: "expense" | "income",
  fallbackRate: number
): number {
  if (!artifact) return Math.max(0, Math.round(fallbackRate))
  return predictDirection(artifact, direction, history, targetDate)
}

interface PlanDay {
  expenseCents: number
  incomeCents: number
  categories: Map<
    number | null,
    { cents: number; name: string; color: string | null }
  >
}

function planDays(
  userId: number,
  accountId: number | null,
  from: string,
  to: string
): Map<string, PlanDay> {
  const result = new Map<string, PlanDay>()
  const occurrences = listOccurrences(
    userId,
    { from, to },
    accountId ?? undefined,
    { includePaused: false }
  )
  for (const occurrence of occurrences) {
    // Booked money already lives in the starting balance / real-future rows,
    // and the always-on analytics bars show even post-horizon bookings. Skip
    // every matched occurrence so no plan and its booked row are both drawn.
    if (occurrence.matched !== null) {
      continue
    }
    const entry = result.get(occurrence.date) ?? {
      expenseCents: 0,
      incomeCents: 0,
      categories: new Map(),
    }
    if (occurrence.amountCents < 0) {
      const cents = -occurrence.amountCents
      entry.expenseCents += cents
      const prior = entry.categories.get(occurrence.categoryId) ?? {
        cents: 0,
        name: occurrence.categoryName ?? "ohne Kategorie",
        color: occurrence.categoryColor,
      }
      prior.cents += cents
      entry.categories.set(occurrence.categoryId, prior)
    } else {
      entry.incomeCents += occurrence.amountCents
    }
    result.set(occurrence.date, entry)
  }
  return result
}

function addCategory(
  rows: Map<
    number | null,
    { name: string; color: string | null; cents: number }
  >,
  categoryId: number | null,
  name: string,
  color: string | null,
  cents: number
): void {
  const prior = rows.get(categoryId) ?? { name, color, cents: 0 }
  prior.cents += cents
  rows.set(categoryId, prior)
}

function toCategoryPoints(
  rows: Map<
    number | null,
    { name: string; color: string | null; cents: number }
  >
): PredictionCategoryPoint[] {
  return [...rows.entries()]
    .map(([categoryId, value]) => ({
      categoryId,
      name: value.name,
      color: value.color,
      expensesCents: value.cents,
    }))
    .filter((row) => row.expensesCents > 0)
    .sort((a, b) => b.expensesCents - a.expensesCents)
}

/**
 * Split integer cents across weights with the largest-remainder method, so
 * the category rows sum exactly to the monthly predicted expense. Rounding
 * each share independently would lose/duplicate a cent.
 */
function allocateCents(
  totalCents: number,
  shares: readonly { categoryId: number | null; share: number }[]
): Map<number | null, number> {
  const result = new Map<number | null, number>()
  if (totalCents <= 0) return result
  if (shares.length === 0) {
    result.set(null, totalCents)
    return result
  }
  const positive = shares.filter((entry) => entry.share > 0)
  if (positive.length === 0) {
    result.set(null, totalCents)
    return result
  }
  const totalWeight = positive.reduce((sum, entry) => sum + entry.share, 0)
  const raw = positive.map((entry) => ({
    categoryId: entry.categoryId,
    exact: (totalCents * entry.share) / totalWeight,
  }))
  let allocated = 0
  for (const entry of raw) {
    const cents = Math.floor(entry.exact)
    result.set(entry.categoryId, cents)
    allocated += cents
  }
  let remainder = totalCents - allocated
  const byRemainder = [...raw].sort(
    (a, b) =>
      b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) ||
      String(a.categoryId ?? "null").localeCompare(
        String(b.categoryId ?? "null")
      )
  )
  for (let i = 0; remainder > 0; i++, remainder--) {
    const entry = byRemainder[i % byRemainder.length]
    result.set(entry.categoryId, (result.get(entry.categoryId) ?? 0) + 1)
  }
  return result
}

/**
 * Build the chart forecast. Always returns two calendar-month buckets (the
 * current remainder and the next month) and a daily balance line, regardless
 * of whether a trained artifact exists yet.
 */
export function computePredictionForecast(
  userId: number,
  options: {
    accountId?: number | null
    today?: string
    /** tests disable the background scheduler; the route keeps it on */
    schedule?: boolean
  } = {}
): PredictionForecast {
  const accountId = options.accountId ?? null
  assertScope(userId, accountId)
  const today = options.today ?? todayLocal()
  const window = predictionWindow(today)

  const dataset = loadDailyDataset(userId, accountId, today)
  const trainingReady =
    dataset !== null && dataset.series.length >= MIN_TRAINING_DAYS
  // An artifact trained on data that has since fallen out of the window (or
  // been deleted) must not keep projecting indefinitely; use the daily
  // baseline until a fresh model exists.
  const loaded = trainingReady ? loadPredictionModel(userId, accountId) : null
  const pending =
    trainingReady && dataset !== null && modelNeedsRefresh(loaded, dataset)
  const retryAt = trainingReady
    ? predictionNextRetryAt(userId, accountId)
    : null
  const retryDue = retryAt === null || retryAt <= new Date().toISOString()
  if (dataset && options.schedule !== false) {
    scheduleIfStale(userId, accountId, dataset, loaded, retryDue)
  }
  const artifact = loaded?.artifact ?? null
  const history = dataset?.series ?? []
  const fallbackExpense = baselineRate(history, "expense")
  const fallbackIncome = baselineRate(history, "income")

  const starting = computeStartingBalance(userId, accountId ?? undefined, today)
  const plans = planDays(userId, accountId, today, window.to)
  const futureBooked = loadFutureBooked(userId, accountId, today, window.to)
  const categoryShares = loadCategoryShares(
    userId,
    accountId,
    today,
    dataset?.matchedTransactionIds
  )

  const monthKeys = monthsBetween(monthOf(today), monthOf(window.to))
  const monthly = new Map<
    string,
    {
      incomeCents: number
      expensesCents: number
      predictedExpensesCents: number
      bookedFutureIncomeCents: number
      bookedFutureExpensesCents: number
      categories: Map<
        number | null,
        { name: string; color: string | null; cents: number }
      >
    }
  >()
  for (const month of monthKeys) {
    monthly.set(month, {
      incomeCents: 0,
      expensesCents: 0,
      predictedExpensesCents: 0,
      bookedFutureIncomeCents: 0,
      bookedFutureExpensesCents: 0,
      categories: new Map(),
    })
  }

  // Today's unmatched plan occurrences are not in the booked starting
  // balance but are already known; fold them into today's point and the
  // current-month bucket.
  const todayPlan = plans.get(today)
  if (todayPlan) {
    const bucket = monthly.get(monthOf(today))
    if (bucket) {
      bucket.incomeCents += todayPlan.incomeCents
      bucket.expensesCents += todayPlan.expenseCents
      for (const [categoryId, value] of todayPlan.categories) {
        addCategory(
          bucket.categories,
          categoryId,
          value.name,
          value.color,
          value.cents
        )
      }
    }
  }

  const projectedBalance: Array<{ date: string; balanceCents: number }> = []
  let running =
    starting.startingBalanceCents +
    (todayPlan?.incomeCents ?? 0) -
    (todayPlan?.expenseCents ?? 0)
  projectedBalance.push({ date: today, balanceCents: running })

  const workingHistory = [...history]
  // The model trains through the last observed booking day. Days without a
  // booking since then are real zero days for feature purposes; append them
  // before forecasting from tomorrow.
  if (workingHistory.length > 0) {
    let cursor = isoDatePlus(workingHistory[workingHistory.length - 1].date, 1)
    while (cursor <= today) {
      workingHistory.push({
        date: cursor,
        expenseCents: 0,
        incomeCents: 0,
      })
      const next = isoDatePlus(cursor, 1)
      if (next === cursor) break
      cursor = next
    }
  }
  const daily: PredictionDayPoint[] = [
    {
      date: today,
      expensesCents: todayPlan?.expenseCents ?? 0,
      incomeCents: todayPlan?.incomeCents ?? 0,
      netCents: (todayPlan?.incomeCents ?? 0) - (todayPlan?.expenseCents ?? 0),
    },
  ]
  let cursor = window.from
  // At the storable ceiling window.from can collapse onto today; today is
  // already represented by the starting balance/plan point.
  if (cursor === today) cursor = ""
  while (cursor !== "" && cursor <= window.to) {
    const known = futureBooked.get(cursor)
    let chartExpenseCents = 0
    let chartIncomeCents = 0
    let balanceExpenseCents = 0
    let balanceIncomeCents = 0
    if (known) {
      // The analytics flow scope already contains already-booked future
      // rows in its actual bars, so the chart prediction must NOT add them
      // again. The balance projection does need them (the starting balance
      // stops at today). For a direction that has a known row, the balance
      // uses the actual amount while the chart uses zero; the opposite
      // direction still uses the model, so unrelated spending is not lost.
      const modelExpense = predictDay(
        artifact,
        workingHistory,
        cursor,
        "expense",
        fallbackExpense
      )
      const modelIncome = predictDay(
        artifact,
        workingHistory,
        cursor,
        "income",
        fallbackIncome
      )
      chartExpenseCents = known.expenseCents > 0 ? 0 : modelExpense
      chartIncomeCents = known.incomeCents > 0 ? 0 : modelIncome
      balanceExpenseCents =
        known.expenseCents > 0 ? known.expenseCents : modelExpense
      balanceIncomeCents =
        known.incomeCents > 0 ? known.incomeCents : modelIncome
      workingHistory.push({
        date: cursor,
        expenseCents: balanceExpenseCents,
        incomeCents: balanceIncomeCents,
      })
    } else {
      chartExpenseCents = predictDay(
        artifact,
        workingHistory,
        cursor,
        "expense",
        fallbackExpense
      )
      chartIncomeCents = predictDay(
        artifact,
        workingHistory,
        cursor,
        "income",
        fallbackIncome
      )
      balanceExpenseCents = chartExpenseCents
      balanceIncomeCents = chartIncomeCents
      workingHistory.push({
        date: cursor,
        expenseCents: chartExpenseCents,
        incomeCents: chartIncomeCents,
      })
    }

    const plan = plans.get(cursor)
    const plannedExpense = plan?.expenseCents ?? 0
    const plannedIncome = plan?.incomeCents ?? 0
    const bucket = monthly.get(cursor.slice(0, 7))
    if (bucket) {
      bucket.expensesCents += chartExpenseCents + plannedExpense
      bucket.incomeCents += chartIncomeCents + plannedIncome
      bucket.predictedExpensesCents += chartExpenseCents
      if (known) {
        bucket.bookedFutureExpensesCents += known.expenseCents
        bucket.bookedFutureIncomeCents += known.incomeCents
      }
    }

    const dayIncome = chartIncomeCents + plannedIncome
    const dayExpenses = chartExpenseCents + plannedExpense
    daily.push({
      date: cursor,
      expensesCents: dayExpenses,
      incomeCents: dayIncome,
      netCents: dayIncome - dayExpenses,
    })
    running +=
      balanceIncomeCents - balanceExpenseCents + plannedIncome - plannedExpense
    projectedBalance.push({ date: cursor, balanceCents: running })

    const next = isoDatePlus(cursor, 1)
    if (next === cursor) break
    cursor = next
  }

  // Allocate predicted residual expenses by live category shares, then add
  // the month's planned categories exactly. Largest-remainder rounding keeps
  // the category rows summing to the monthly expense total.
  for (const bucket of monthly.values()) {
    const allocated = allocateCents(
      bucket.predictedExpensesCents,
      categoryShares
    )
    for (const [categoryId, cents] of allocated) {
      const share = categoryShares.find(
        (entry) => entry.categoryId === categoryId
      )
      addCategory(
        bucket.categories,
        categoryId,
        share?.name ?? "ohne Kategorie",
        share?.color ?? null,
        cents
      )
    }
  }
  for (const [date, plan] of plans) {
    if (date <= today) continue
    const bucket = monthly.get(date.slice(0, 7))
    if (!bucket) continue
    for (const [categoryId, value] of plan.categories) {
      addCategory(
        bucket.categories,
        categoryId,
        value.name,
        value.color,
        value.cents
      )
    }
  }

  const points: PredictionMonthPoint[] = monthKeys.map((month) => {
    const value = monthly.get(month)!
    return {
      month,
      partial: month === monthOf(today),
      incomeCents: value.incomeCents,
      expensesCents: value.expensesCents,
      netCents: value.incomeCents - value.expensesCents,
      bookedFuture: {
        incomeCents: value.bookedFutureIncomeCents,
        expensesCents: value.bookedFutureExpensesCents,
      },
      categories: toCategoryPoints(value.categories),
    }
  })

  return {
    today,
    horizon: { from: today, to: window.to, months: points.length },
    startingBalanceCents: starting.startingBalanceCents,
    withoutSnapshot: starting.withoutSnapshot,
    monthly: points,
    daily,
    projectedBalance,
    source: artifact ? "model" : "baseline",
    pending,
    retryAt,
  }
}
