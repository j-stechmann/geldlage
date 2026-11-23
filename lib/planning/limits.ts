/**
 * Planning limits, shared by the server validation, the forecast route and
 * service, plan matching and the plan dialog (ADR-0035/0037). The calendar
 * window caps live in `lib/api/query.ts` beside `parseWindow`.
 *
 * The free-text byte limits matter on both sides: HTML maxLength counts JS
 * characters, never UTF-8 bytes, so an input allowing 128 characters would
 * admit multi-byte values (umlauts, emoji) the server must reject. Both sides
 * read the same numbers and stay in sync by construction.
 */
export const MAX_COUNTERPARTY = 128
export const MAX_TEXT = 500

/** forecast horizon cap (months) */
export const MAX_FORECAST_MONTHS = 60

/** A real transaction may post BEFORE the due date (max 5 days early). */
export const MATCH_DAYS_BEFORE = 5
/** …or after (SEPA debits commonly post 1–2 days late; max 7). */
export const MATCH_DAYS_AFTER = 7
/** Smallest accepted amount deviation: 5 €. */
export const AMOUNT_TOLERANCE_FLOOR_CENTS = 500
/** …or 1 % of the planned amount, whichever is larger. */
export const AMOUNT_TOLERANCE_PCT = 0.01
