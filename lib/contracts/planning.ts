/**
 * Shared planning contracts (ADR-0037).
 *
 * Types plus the status vocabulary constant — no runtime dependencies beyond
 * that array. This module must stay import-safe for client components: no
 * drizzle, no `lib/db`, no server-only imports. The planning service and
 * `components/planning/api.ts` both import these shapes so the wire contract
 * can no longer drift between server and client.
 */

export const PLAN_STATUSES = ["active", "paused", "finished"] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]
/** Occurrences only ever expand for these two statuses. */
export type PlanOccurrenceStatus = "active" | "paused"

export interface PlanInput {
  accountId?: number | null
  counterparty?: string | null
  purpose?: string | null
  /** signed cents — required on create, optional on patch (key-presence patch) */
  amountCents?: number
  categoryId?: number | null
  dtstart?: string
  /** NULL/"" = one-off on dtstart; otherwise a bare RFC 5545 RRULE (allowlisted) */
  rrule?: string | null
  status?: PlanStatus
  notes?: string | null
}
export type PlanInputKey = keyof PlanInput

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

/** Paged list row: the route adds the computed next occurrence. */
export interface PlanListRow extends PlanRow {
  nextDueDate: string | null
}

export type PlanStatusFilter = PlanStatus | "all"

export interface PlanListFilters {
  /** free-text search over counterparty/purpose/notes/account/category */
  q?: string
  status?: PlanStatus | "all"
}

/** Page as the service returns it (before the route adds nextDueDate). */
export interface PlanPage {
  plans: PlanRow[]
  total: number
  page: number
  pageCount: number
}

/** Page as the wire serves it to the paged table. */
export interface PlanListPage {
  plans: PlanListRow[]
  total: number
  page: number
  pageCount: number
}

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
  /**
   * active | paused — paused occurrences expand for calendar/list reads;
   * forecasts exclude them.
   */
  planStatus: PlanOccurrenceStatus
  matched: {
    transactionId: string
    bookingDate: string
    amountCents: number
  } | null
}

/**
 * Prefill source for the plan dialog's create mode — built from an existing
 * context (e.g. a booked transaction being "umgewandelt"). Pure data: the
 * dialog derives the direction from the amount sign and guesses a monthly
 * recurrence from the dtstart day-of-month. No linkage is stored.
 */
export interface PlanPrefill {
  amountCents: number
  dtstart: string
  counterparty: string | null
  purpose: string | null
  accountId: number | null
  categoryId: number | null
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
