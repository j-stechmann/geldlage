/**
 * Planning limits, shared by the server validation, the calendar routes and
 * the plan dialog (ADR-0035/0037).
 *
 * The free-text byte limits matter on both sides: HTML maxLength counts JS
 * characters, never UTF-8 bytes, so an input allowing 128 characters would
 * admit multi-byte values (umlauts, emoji) the server must reject. Both sides
 * read the same numbers and stay in sync by construction.
 */
export const MAX_COUNTERPARTY = 128
export const MAX_TEXT = 500

/** occurrence-window cap for the occurrences/calendar endpoints (days) */
export const MAX_OCCURRENCE_WINDOW_DAYS = 400
/**
 * Window distance cap, each side of today (= 60 months, the forecast
 * horizon cap). rrule expansion iterates occurrence by occurrence from
 * dtstart up to the window start — it cannot seek — so an arbitrary far
 * window would make every recurring plan cost CPU linear in that distance
 * on every read (measured: ~0.6 s per DAILY plan for a window at year
 * 2999, ~6 s at 9999). Everything that actually queries occurrences stays
 * far inside: the /calendar page navigates month-sized windows. The two
 * calendar endpoints share these caps so they fail together.
 */
export const MAX_WINDOW_DISTANCE_DAYS = 1826
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
