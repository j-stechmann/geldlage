/**
 * Planning limits, shared by the server validation, the planning service,
 * plan matching and the plan dialog (ADR-0035/0037). The calendar
 * window caps live in `lib/api/query.ts` beside `parseWindow`.
 *
 * The free-text byte limits matter on both sides: HTML maxLength counts JS
 * characters, never UTF-8 bytes, so an input allowing 128 characters would
 * admit multi-byte values (umlauts, emoji) the server must reject. Both sides
 * read the same numbers and stay in sync by construction.
 */
export const MAX_COUNTERPARTY = 128
export const MAX_TEXT = 500

/**
 * dtstart floor (year): occurrence expansion walks forward from dtstart on
 * every read (plan list, occurrences, forecast) and rrule has no internal
 * iteration cap — per-read cost is linear in the walk distance
 * (window end − dtstart) and grows forever with plan age, so a 1900-floor
 * DAILY plan already iterates ~126 years (~70 ms measured) on every read
 * window that touches today. The floor bounds the worst case at one
 * century-and-a-quarter back; anything earlier has no representable purpose
 * (bank data never reaches that far). Shared with the dialog (the client
 * preview must enforce the same floor) and the service validator.
 */
export const MIN_DTSTART_YEAR = 1900

/** A real transaction may post BEFORE the due date (max 5 days early). */
export const MATCH_DAYS_BEFORE = 5
/** …or after (SEPA debits commonly post 1–2 days late; max 7). */
export const MATCH_DAYS_AFTER = 7
/** Smallest accepted amount deviation: 5 €. */
export const AMOUNT_TOLERANCE_FLOOR_CENTS = 500
/** …or 1 % of the planned amount, whichever is larger. */
export const AMOUNT_TOLERANCE_PCT = 0.01
