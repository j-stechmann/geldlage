/**
 * Shared date helpers (ADR-0037).
 *
 * Pure and client-safe: no rrule, no drizzle, no server modules. The helpers
 * keep the invalid-input contracts their call sites rely on (they are load
 * bearing) and fail loudly where a malformed value could otherwise corrupt an
 * output or hang a loop:
 *
 * - `isoDatePlus` throws only for input `Date` cannot parse; a parseable but
 *   impossible day/month normalizes like `Date` (routes validate first);
 * - `isoShift` returns "" only for unparseable input (the matcher filters it
 *   out); impossible-but-parseable dates normalize the same way;
 * - `dayDiff` returns NaN only for unparseable input (NaN comparisons are
 *   false), with the same normalization caveat;
 * - the month-series helpers (`monthOffset`, `monthCountBetween`,
 *   `monthsBetween`, `lastDayOfMonthIso`, `lastDayOfMonthDay`) throw a
 *   RangeError for a value that is neither a real `YYYY-MM` key nor a real
 *   `YYYY-MM-DD` date — a malformed key must never reach a response or SQL,
 *   and an unvalidated loop bound could otherwise never terminate.
 *
 * Calendar dates are plain `YYYY-MM-DD` strings. UTC arithmetic anchors at
 * noon so DST never shifts a day; local-calendar helpers are separate and
 * documented as such.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Lowest representable ISO date (four-digit years only). */
export const MIN_ISO_DATE = "0000-01-01"
/** Highest storable ISO date (four-digit years only). */
export const MAX_ISO_DATE = "9999-12-31"

/**
 * The representable month-key range, derived from the ISO bounds so the
 * routes' validation and the engine's boundary guards cannot drift apart.
 * Lowest representable "YYYY-MM" month key.
 */
export const MIN_MONTH_KEY = MIN_ISO_DATE.slice(0, 7)
/** Highest representable "YYYY-MM" month key. */
export const MAX_MONTH_KEY = MAX_ISO_DATE.slice(0, 7)

const MIN_MONTH_YEAR = Number(MIN_MONTH_KEY.slice(0, 4))
const MAX_MONTH_YEAR = Number(MAX_MONTH_KEY.slice(0, 4))

/**
 * Cap on the date-range month series. The analytics engine materializes one
 * bucket per month between the effective date bounds; without a cap a single
 * request can expand the whole representable calendar (~120k months). 1200
 * months (100 years) comfortably exceeds real bank history while keeping the
 * response small and the expansion cheap.
 */
export const MAX_DATE_RANGE_MONTHS = 1200

/**
 * UTC Date without Date.UTC's year 0–99 → 1900–1999 remap. The setters keep
 * Date.UTC's out-of-range day/month normalization and its extended-year
 * overflow past 9999.
 */
function utcDate(year: number, month: number, day: number, hours = 0): Date {
  const d = new Date(0)
  d.setUTCHours(hours, 0, 0, 0)
  d.setUTCFullYear(year, month - 1, day)
  return d
}

/** Last calendar day of a 1-based month (UTC calendar). */
export function daysInMonth(year: number, month: number): number {
  // day 0 normalizes to the last day of the previous month.
  return utcDate(year, month + 1, 0).getUTCDate()
}

/** "YYYY-MM-DD" from UTC calendar parts (four-digit years). */
export function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** True for "YYYY-MM-DD" names of real calendar days (incl. leap years). */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const [y, m, d] = s.split("-").map(Number)
  if (m < 1 || m > 12) return false
  return d >= 1 && d <= daysInMonth(y, m)
}

/** Noon UTC instant of an ISO date — DST/month-end safe. */
export function noonUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return utcDate(y, m, d, 12)
}

/**
 * ISO date exactly `days` days from an ISO date (UTC calendar arithmetic).
 * Out-of-range day/month parts normalize like `Date`; only unparseable input
 * throws.
 */
export function isoDatePlus(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  return utcDate(y, m, d + days, 12)
    .toISOString()
    .slice(0, 10)
}

/**
 * ISO date ± days, "" for unparseable input. The planning matcher uses this
 * tolerant form when building candidate windows.
 */
export function isoShift(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(t)) return ""
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * Absolute day difference between two ISO dates. NaN for unparseable input —
 * callers compare with `<=`, which stays false for NaN.
 */
export function dayDiff(isoA: string, isoB: string): number {
  const a = Date.parse(`${isoA}T00:00:00Z`)
  const b = Date.parse(`${isoB}T00:00:00Z`)
  return Math.abs(Math.round((a - b) / 86_400_000))
}

/**
 * Local calendar date of a Date (YYYY-MM-DD). Not UTC-based: toISOString()
 * shifts the date for timezones east of UTC before noon / west after noon,
 * which would name the wrong calendar day.
 */
export function isoDateLocal(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** Local calendar date (YYYY-MM-DD) — the "today" used by routes/UI. */
export function todayLocal(): string {
  return isoDateLocal(new Date())
}

/** "YYYY-MM" month key of an ISO date. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** True for a real "YYYY-MM" month key (four-digit year, month 01…12). */
export function isValidMonthKey(monthKey: string): boolean {
  return isValidIsoDate(`${monthKey}-01`)
}

/**
 * Numeric parts of a validated month key (a full ISO date is accepted too).
 * The whole value is validated — a valid 7-char prefix with trailing garbage
 * must not be read as that month.
 */
function monthParts(value: string): [number, number] {
  if (!isValidMonthKey(value) && !isValidIsoDate(value)) {
    throw new RangeError(`invalid month key "${value}"`)
  }
  const [y, m] = value.slice(0, 7).split("-").map(Number)
  return [y, m]
}

/**
 * "YYYY-MM" month key `offset` months from the month containing baseIso.
 * Throws RangeError for an invalid month key, a non-integer offset, or a
 * result outside the representable MIN_MONTH_KEY … MAX_MONTH_KEY range
 * (prevMonth("0000-01") and nextMonth("9999-12") are therefore errors, not
 * silent corruptions).
 */
export function monthOffset(baseIso: string, offset: number): string {
  const [y, m] = monthParts(baseIso)
  if (!Number.isInteger(offset)) {
    throw new RangeError(`month offset must be an integer: ${offset}`)
  }
  const total = y * 12 + (m - 1) + offset
  const ny = Math.floor(total / 12)
  if (ny < MIN_MONTH_YEAR || ny > MAX_MONTH_YEAR) {
    throw new RangeError(
      `month offset from "${baseIso}" by ${offset} leaves ${MIN_MONTH_KEY}…${MAX_MONTH_KEY}`
    )
  }
  // Positive modulo: keeps the month in 1…12 for every in-range year.
  const nm = (((total % 12) + 12) % 12) + 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}

/**
 * Last day of the month named by a "YYYY-MM" key, as "YYYY-MM-DD".
 * Throws RangeError for an invalid month key (see `monthParts`).
 */
export function lastDayOfMonthIso(monthKey: string): string {
  const [y, m] = monthParts(monthKey)
  return isoDate(y, m, daysInMonth(y, m))
}

/**
 * Zero-padded day-of-month of the last calendar day of iso's month. Validates
 * like `lastDayOfMonthIso`: a malformed value throws instead of deriving a
 * day from `NaN` parts.
 */
export function lastDayOfMonthDay(iso: string): string {
  const [y, m] = monthParts(iso)
  return String(daysInMonth(y, m)).padStart(2, "0")
}

/** Previous "YYYY-MM" month key (valid keys only; needs a predecessor). */
export function prevMonth(month: string): string {
  return monthOffset(month, -1)
}

/** Next "YYYY-MM" month key (valid keys only; needs a successor). */
export function nextMonth(month: string): string {
  return monthOffset(month, 1)
}

/**
 * Inclusive month count between two ISO dates/months. <= 0 when `fromIso`
 * is after `toIso` — the non-allocating counterpart of `monthsBetween`, for
 * span caps that must not materialize the range first. Throws RangeError for
 * an invalid month key.
 */
export function monthCountBetween(fromIso: string, toIso: string): number {
  const [fy, fm] = monthParts(fromIso)
  const [ty, tm] = monthParts(toIso)
  return (ty - fy) * 12 + (tm - fm) + 1
}

/**
 * True when the inclusive month span between the bounds exceeds the cap.
 * Both bounds must be valid month keys (RangeError otherwise).
 */
export function monthSpanExceedsCap(fromIso: string, toIso: string): boolean {
  return monthCountBetween(fromIso, toIso) > MAX_DATE_RANGE_MONTHS
}

/**
 * List of "YYYY-MM" keys between two ISO dates/months, inclusive. Throws
 * RangeError for an invalid month key — a `NaN` month would otherwise make
 * the loop bound never advance (an empty key hung forever).
 */
export function monthsBetween(fromIso: string, toIso: string): string[] {
  const months: string[] = []
  let [y, m] = monthParts(fromIso)
  const [ty, tm] = monthParts(toIso)
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return months
}
