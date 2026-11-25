/**
 * Prediction wire contracts.
 *
 * Client-safe: no drizzle, no `lib/db`, no server-only imports. The dashboard
 * charts and the server forecast endpoint share these shapes so the 2-month
 * overlay cannot drift between the two sides.
 */

/** Fixed display horizon: the current month remainder plus the next month. */
export const PREDICTION_HORIZON_MONTHS = 2

/** German month label for the shared horizon copy. */
export function predictionMonthsLabel(months: number): string {
  return months === 1 ? "Monat" : "Monate"
}

export interface PredictionCategoryPoint {
  categoryId: number | null
  name: string
  color: string | null
  /** predicted expenses for this month (positive cents) */
  expensesCents: number
}

export interface PredictionDayPoint {
  date: string
  /** predicted remaining expenses on the day (positive cents) */
  expensesCents: number
  /** predicted remaining income on the day (positive cents) */
  incomeCents: number
  netCents: number
}

export interface PredictionMonthPoint {
  month: string
  /** true for the current (partially elapsed) month */
  partial: boolean
  /** predicted remaining income in the month (positive cents) */
  incomeCents: number
  /** predicted remaining expenses in the month (positive cents) */
  expensesCents: number
  netCents: number
  /** certain already-booked future rows in the month (positive cents) */
  bookedFuture: { incomeCents: number; expensesCents: number }
  categories: PredictionCategoryPoint[]
}

/**
 * The chart-facing prediction envelope. It deliberately mirrors the old
 * forecast shapes closely enough that the existing chart merge logic can be
 * adapted without changing the visual language.
 */
export interface PredictionForecast {
  today: string
  horizon: { from: string; to: string; months: number }
  startingBalanceCents: number
  withoutSnapshot: boolean
  monthly: PredictionMonthPoint[]
  /** daily forecast points from today through the horizon end */
  daily: PredictionDayPoint[]
  /** running balance for every forecast day, ascending, starting today */
  projectedBalance: Array<{ date: string; balanceCents: number }>
  /** "baseline" means no trained artifact was available yet */
  source: "model" | "baseline"
  /** true while the current artifact is missing/stale and a refresh is queued or scheduled */
  pending: boolean
  /** scheduled backoff instant while a failed scope waits to retry */
  retryAt: string | null
}
