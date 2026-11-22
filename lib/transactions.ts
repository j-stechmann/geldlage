/**
 * Transaction movement helpers (ADR-0037).
 *
 * The row direction carries the counterparty: outgoing rows name the payee,
 * incoming rows the payer. This used to be reimplemented in the transaction
 * row, the calendar route and the calendar projection; it now lives here and
 * is shared by the transaction row, the analytics calendar projection, the
 * plan prefill, the labeller worker and the assign-label dialog.
 */

export interface TransactionParty {
  type: string
  payee: string | null
  payer: string | null
}

export function counterpartyOf(row: TransactionParty): string | null {
  return row.type === "Ausgang" ? row.payee : row.payer
}
