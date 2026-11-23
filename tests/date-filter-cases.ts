/**
 * Shared date-contract query matrices. The parser test, both route tests and
 * the parity test exercise the same cases; keeping the lists here stops the
 * copies from drifting.
 */

/** Malformed or unrepresentable date params. */
export const INVALID_DATE_QUERIES = [
  "dateFrom=nope",
  "dateTo=2026-02-29",
  "dateFrom=10000-01-01",
] as const

/** Explicit two-sided ranges wider than the 1200-month cap. */
export const OVER_CAP_TWO_SIDED_QUERIES = [
  "dateFrom=0001-01-01&dateTo=9998-12-31",
  "dateFrom=0000-01-01&dateTo=9999-12-31",
] as const
