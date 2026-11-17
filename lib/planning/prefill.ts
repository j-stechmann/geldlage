/**
 * Plan-dialog prefill from a transaction-like movement (ADR-0037).
 *
 * Pure data — the dialog derives the direction from the amount sign and
 * guesses a monthly recurrence from dtstart. No linkage is stored; plans keep
 * being read-time matched against bookings. Shared by the transactions table
 * (full row) and the calendar (compact projection).
 */
import type { PlanPrefill } from "@/lib/contracts/planning"
import type { TransactionRow } from "@/lib/contracts/transactions"
import { counterpartyOf } from "@/lib/transactions"

export interface PlanPrefillSource {
  amountCents: number
  counterparty: string | null
  purpose: string | null
  /** the movement date: bookingDate (table) or date (calendar projection) */
  date: string
  accountId: number | null
  categoryId: number | null
}

export function planPrefill(source: PlanPrefillSource): PlanPrefill {
  return {
    counterparty: source.counterparty,
    purpose: source.purpose,
    amountCents: source.amountCents,
    dtstart: source.date,
    accountId: source.accountId,
    categoryId: source.categoryId,
  }
}

export function planPrefillFromTx(row: TransactionRow): PlanPrefill {
  return planPrefill({
    counterparty: counterpartyOf(row),
    purpose: row.purpose,
    amountCents: row.amountCents,
    date: row.bookingDate,
    accountId: row.accountId,
    categoryId: row.categoryId,
  })
}
