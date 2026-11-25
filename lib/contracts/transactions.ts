/**
 * Shared transaction contracts (ADR-0037).
 *
 * Types only — client-safe. `TransactionRow` is the full transactions-table
 * projection; `CalendarTransaction` is the deliberately compact calendar
 * projection (derived counterparty, always-present account, narrower status).
 * They stay separate shapes; only the type declarations are single-sourced.
 */

export interface TransactionRow {
  id: string
  bookingDate: string
  valueDate: string | null
  status: string
  payer: string | null
  payee: string | null
  purpose: string | null
  type: string
  counterpartyIban: string | null
  amountCents: number
  creditorId: string | null
  mandateRef: string | null
  customerRef: string | null
  accountId: number
  accountName: string | null
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  labelStatus: string
}

export interface TransactionPage {
  rows: TransactionRow[]
  total: number
  page: number
  pageCount: number
}

export interface CalendarTransaction {
  id: string
  date: string
  /** verbatim DKB status: Gebucht | Nicht gebucht */
  status: "Gebucht" | "Nicht gebucht"
  /** payee for Ausgang, payer for Eingang — see lib/transactions.ts */
  counterparty: string | null
  purpose: string | null
  amountCents: number
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  /** always present — transactions.account_id is NOT NULL */
  accountId: number
}
