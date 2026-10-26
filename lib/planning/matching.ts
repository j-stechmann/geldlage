/**
 * Read-time matching of planned occurrences against booked transactions
 * (ADR-0035). Nothing is stored: each request expands occurrences, pulls
 * booked rows from the same window (± posting drift) and pairs them with a
 * deterministic greedy assignment — the same 1:1 pairing style as the
 * import reconcile (lib/db/match.ts). Zero storage → zero drift (ADR-0019
 * spirit); a rule change can never leave stale match rows behind.
 */
import { normalizeWhitespace } from "@/lib/money"

/** A real transaction may post BEFORE the due date (max 5 days early). */
export const MATCH_DAYS_BEFORE = 5
/** …or after (SEPA debits commonly post 1–2 days late; max 7). */
export const MATCH_DAYS_AFTER = 7
/** Smallest accepted amount deviation: 5 €. */
export const AMOUNT_TOLERANCE_FLOOR_CENTS = 500
/** …or 1 % of the planned amount, whichever is larger. */
export const AMOUNT_TOLERANCE_PCT = 0.01

export interface MatchableOccurrence {
  /** stable occurrence key: `${planId}::${date}` */
  occurrenceKey: string
  /** due date, ISO */
  date: string
  /** signed cents, same convention as transactions */
  amountCents: number
  /** when set, the transaction's payer OR payee must contain it (case-insensitive) */
  counterparty: string | null
  /** restrict candidates to the plan's account (null = any account) */
  accountId: number | null
}

export interface MatchCandidate {
  id: string
  bookingDate: string
  amountCents: number
  payer: string | null
  payee: string | null
  accountId: number
}

export interface OccurrenceMatch {
  occurrenceKey: string
  transactionId: string
}

/** ISO date ± days (UTC calendar arithmetic); "" for non-date input. */
function isoShift(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(t)) return ""
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

/** First index with bookingDate >= from ("": no bound → 0). */
function lowerBoundByDate(tx: MatchCandidate[], from: string): number {
  if (from === "") return 0
  let lo = 0
  let hi = tx.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tx[mid].bookingDate < from) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index with bookingDate > to ("": no candidates → 0). */
function upperBoundByDate(tx: MatchCandidate[], to: string): number {
  if (to === "") return 0
  let lo = 0
  let hi = tx.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tx[mid].bookingDate <= to) lo = mid + 1
    else hi = mid
  }
  return lo
}

function amountWithinTolerance(planCents: number, txCents: number): boolean {
  const tolerance = Math.max(
    AMOUNT_TOLERANCE_FLOOR_CENTS,
    Math.round(Math.abs(planCents) * AMOUNT_TOLERANCE_PCT)
  )
  return Math.abs(planCents - txCents) <= tolerance
}

function counterpartyMatches(planCp: string, tx: MatchCandidate): boolean {
  const needle = normalizeWhitespace(planCp).toLowerCase()
  if (needle === "") return true
  return (
    (tx.payer !== null &&
      normalizeWhitespace(tx.payer).toLowerCase().includes(needle)) ||
    (tx.payee !== null &&
      normalizeWhitespace(tx.payee).toLowerCase().includes(needle))
  )
}

function viable(occ: MatchableOccurrence, tx: MatchCandidate): number | null {
  if (tx.bookingDate === "") return null
  const offsetMs =
    Date.parse(`${tx.bookingDate}T00:00:00Z`) -
    Date.parse(`${occ.date}T00:00:00Z`)
  const offset = offsetMs / 86_400_000
  if (!Number.isFinite(offset)) return null
  if (offset < -MATCH_DAYS_BEFORE || offset > MATCH_DAYS_AFTER) return null
  // plans are validated non-zero; a 0-cent row (reservation placeholders,
  // reversed card holds) must never check a plan off — as a non-positive it
  // would slip the sign check for expense plans and clear the 5 € tolerance
  // floor for plans of ≤ 5 € (|plan − 0| ≤ 500)
  if (tx.amountCents === 0) return null
  if (occ.amountCents > 0 !== tx.amountCents > 0) return null
  if (occ.accountId !== null && occ.accountId !== tx.accountId) return null
  if (occ.counterparty !== null && !counterpartyMatches(occ.counterparty, tx))
    return null
  if (!amountWithinTolerance(occ.amountCents, tx.amountCents)) return null
  return Math.abs(offset)
}

interface PairCandidate {
  occurrenceKey: string
  transactionId: string
  /** |date offset| in whole days (sort key 1) */
  offsetAbs: number
  /** |amount difference| (sort key 2) */
  amountDiff: number
  txId: string
}

/**
 * Greedy 1:1 pairing, earliest-and-closest first: candidates sort by
 * |date offset|, then |amount difference|, then transaction id; each
 * occurrence and each transaction is consumed at most once. Results are
 * deterministic for a given (occurrences, transactions) input.
 *
 * Candidate rows are sorted once by bookingDate so every occurrence only
 * evaluates its [+5/−7] day slice instead of every row — for the wide
 * forecast windows this turns the pairing into O(N·log M) lookups over
 * ≤ 13-day slices. The result set is unchanged: the date slice exactly
 * mirrors viable()'s date bound, and pairs are fully re-sorted afterwards.
 */
export function matchPlannedOccurrences(
  occurrences: MatchableOccurrence[],
  transactions: MatchCandidate[]
): OccurrenceMatch[] {
  const sortedTx = [...transactions].sort(
    (a, b) =>
      a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id)
  )
  const pairs: PairCandidate[] = []
  for (const occ of occurrences) {
    const lo = lowerBoundByDate(
      sortedTx,
      isoShift(occ.date, -MATCH_DAYS_BEFORE)
    )
    const hi = upperBoundByDate(sortedTx, isoShift(occ.date, MATCH_DAYS_AFTER))
    for (let i = lo; i < hi; i++) {
      const tx = sortedTx[i]
      const offsetAbs = viable(occ, tx)
      if (offsetAbs === null) continue
      pairs.push({
        occurrenceKey: occ.occurrenceKey,
        transactionId: tx.id,
        offsetAbs,
        amountDiff: Math.abs(occ.amountCents - tx.amountCents),
        txId: tx.id,
      })
    }
  }
  pairs.sort(
    (a, b) =>
      a.offsetAbs - b.offsetAbs ||
      a.amountDiff - b.amountDiff ||
      a.txId.localeCompare(b.txId) ||
      a.occurrenceKey.localeCompare(b.occurrenceKey)
  )
  const usedTx = new Set<string>()
  const usedOcc = new Set<string>()
  const matches: OccurrenceMatch[] = []
  for (const p of pairs) {
    if (usedTx.has(p.transactionId) || usedOcc.has(p.occurrenceKey)) continue
    usedTx.add(p.transactionId)
    usedOcc.add(p.occurrenceKey)
    matches.push({
      occurrenceKey: p.occurrenceKey,
      transactionId: p.transactionId,
    })
  }
  matches.sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey))
  return matches
}
