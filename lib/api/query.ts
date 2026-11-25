/**
 * Shared query-parameter contracts for the list/window routes (ADR-0037).
 *
 * Server-only. The helpers keep the original route semantics except for the
 * documented contract changes: strict date validation (400 invalid_date), an
 * unrepresentable OFFSET answering an empty page that echoes the requested
 * number (guarded in lib/pagination.ts), and the from-side window distance
 * check running before `to` is validated. Otherwise they stay parseInt-lenient
 * for pages, digits-only for ids, and keep the calendar window precedence
 * (from → from-distance → to → order → to-distance → width).
 */
import {
  isoDatePlus,
  isValidIsoDate,
  MAX_ISO_DATE,
  MIN_ISO_DATE,
} from "@/lib/dates"

export function positiveInt(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/**
 * Positive page number, 1 for missing/non-numeric/non-positive input. Huge
 * finite pages (above 2^53) are accepted and echoed at JSON-number precision:
 * SQLite can bind their offsets up to 2^63, and beyond that `paginate`
 * answers an empty page. `parseInt` stays deliberately lenient (`"3abc"` → 3,
 * `"1e18"` → 1).
 */
export function parsePage(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isInteger(n) && n > 0 ? n : 1
}

export interface PaginationOptions {
  defaultPageSize: number
  maxPageSize: number
  /** plans' legacy full-list contract: only paginate when a param is sent */
  onlyWhenPresent?: boolean
}

export interface Pagination {
  page: number
  pageSize: number
  paginated: boolean
}

export function parsePagination(
  sp: URLSearchParams,
  opts: PaginationOptions
): Pagination {
  const paginated = opts.onlyWhenPresent
    ? sp.has("page") || sp.has("pageSize")
    : true
  const pageSize = Math.min(
    positiveInt(sp.get("pageSize"), opts.defaultPageSize),
    opts.maxPageSize
  )
  return { page: parsePage(sp.get("page")), pageSize, paginated }
}

export type ParamResult<T> = { ok: true; value: T } | { ok: false }

/**
 * Optional positive integer query param, digits-only: parseInt alone would
 * coerce "12.9" → 12 or "12abc" → 12 — a mangled param silently reading a
 * different value than the client asked for.
 */
export function parseOptionalAccountId(
  raw: string | null
): ParamResult<number | undefined> {
  if (raw === null) return { ok: true, value: undefined }
  if (!/^\d+$/.test(raw)) return { ok: false }
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n <= 0) return { ok: false }
  return { ok: true, value: n }
}

/** Optional digits-only integer clamped into [min, max]; absent → fallback. */
export function parseOptionalClampedInt(
  raw: string | null,
  opts: { min: number; max: number; fallback: number }
): ParamResult<number> {
  if (raw === null) return { ok: true, value: opts.fallback }
  if (!/^\d+$/.test(raw)) return { ok: false }
  const n = Number.parseInt(raw, 10)
  return { ok: true, value: Math.min(Math.max(n, opts.min), opts.max) }
}

/**
 * Absent/empty = unbounded; otherwise a real ISO date in the four-digit range.
 * `isValidIsoDate` already enforces `^\d{4}-\d{2}-\d{2}$` plus a real month
 * and day, so it is also the representable-range check (0000-01-01 …
 * 9999-12-31) — no separate comparison can fire.
 */
export function parseAnalyticsDate(
  raw: string | null
): ParamResult<string | undefined> {
  if (raw === null || raw === "") return { ok: true, value: undefined }
  if (!isValidIsoDate(raw)) return { ok: false }
  return { ok: true, value: raw }
}

export type DateRangeParse =
  | { ok: true; dateFrom?: string; dateTo?: string }
  | { ok: false; error: "invalid_date"; message: string }

/**
 * Shared date-filter contract for the list routes. `/api/analytics` and
 * `/api/transactions` parse the same FilterBar params, so they accept and
 * reject the same *dates*.
 *
 * The parser deliberately accepts every in-range range, however wide: how
 * much work a span costs is the engine's concern, not the request contract's.
 * `/api/analytics` materializes one bucket per month, but only up to
 * `MAX_DATE_RANGE_MONTHS` — a wider span degrades to the months that actually
 * have data (see `computeAnalytics`) rather than rejecting a range the
 * FilterBar lets a user pick. The transactions list binds the dates into SQL
 * and is cheap for any width.
 *
 * `dateFrom > dateTo` is deliberately accepted: the month count is <= 0, no
 * rows match, and both routes return an empty filtered list — the pre-existing
 * behavior. (The analytics balance KPI is deliberately unfiltered, so it still
 * resolves as of `dateTo`; see docs/analytics.md.)
 */
export function parseDateRange(sp: URLSearchParams): DateRangeParse {
  const from = parseAnalyticsDate(sp.get("dateFrom"))
  const to = parseAnalyticsDate(sp.get("dateTo"))
  if (!from.ok || !to.ok) {
    return {
      ok: false,
      error: "invalid_date",
      message: `dateFrom/dateTo must be ISO dates between ${MIN_ISO_DATE} and ${MAX_ISO_DATE}`,
    }
  }

  return { ok: true, dateFrom: from.value, dateTo: to.value }
}

export type WindowErrorCode =
  "invalid_window" | "window_too_far" | "window_too_large"

export type WindowParse =
  | { ok: true; from: string; to: string }
  | { ok: false; error: WindowErrorCode; message: string }

/** occurrence-window cap for the occurrences/calendar endpoints (days) */
export const MAX_OCCURRENCE_WINDOW_DAYS = 400
/**
 * Window distance cap, each side of today (= 60 months). rrule expansion
 * iterates occurrence by occurrence from
 * dtstart up to the window start — it cannot seek — so an arbitrary far
 * window would make every recurring plan cost CPU linear in that distance
 * on every read (measured: ~0.6 s per DAILY plan for a window at year
 * 2999, ~6 s at 9999). Everything that actually queries occurrences stays
 * far inside: the /calendar page navigates month-sized windows. The two
 * calendar endpoints share these caps so they fail together.
 */
export const MAX_WINDOW_DISTANCE_DAYS = 1826

/** Shared `window_too_far` result so both distance checks stay in lockstep. */
function windowTooFar(): WindowParse {
  return {
    ok: false,
    error: "window_too_far",
    message: `window must lie within ${MAX_WINDOW_DISTANCE_DAYS} days of today`,
  }
}

/**
 * Clamp a date-arithmetic result that left the four-digit ISO range. ISO
 * string comparison puts the extended-year form ("+010000-…", "-000001-…")
 * below every real date, so an unclamped bound would reject every window.
 */
function clampIsoBound(iso: string): string {
  if (isValidIsoDate(iso)) return iso
  return iso.startsWith("-") ? MIN_ISO_DATE : MAX_ISO_DATE
}

/**
 * Shared calendar-window contract. With no options both bounds are required;
 * passing `defaultToDays` defaults `from` to today and `to` to
 * `from + defaultToDays`. Distance cap runs before the width cap: expansion
 * walks rrule from dtstart (no seek), and the width cap's own isoDatePlus
 * arithmetic overflows near year 9999. Validating `from` before deriving the
 * default `to` keeps a malformed `from` a 400, not a 500; distance-checking
 * the `from` side before the derivation keeps a near-MAX_ISO_DATE `from` a
 * `window_too_far` rather than an invalid extended-year default.
 *
 * `today` is part of the caller's contract (routes pass `todayLocal()`), but
 * the bound arithmetic is clamped so a near-ceiling today still yields
 * comparable bounds instead of extended-year strings, and a malformed today
 * answers `invalid_window` instead of throwing.
 */
export function parseWindow(
  sp: URLSearchParams,
  today: string,
  opts?: { defaultToDays: number }
): WindowParse {
  if (!isValidIsoDate(today)) {
    return {
      ok: false,
      error: "invalid_window",
      message: "today must be an ISO date",
    }
  }

  const rawFrom = sp.get("from")
  const from = rawFrom ?? (opts ? today : null)
  if (from === null || !isValidIsoDate(from)) {
    return {
      ok: false,
      error: "invalid_window",
      message: "from/to must be ISO dates",
    }
  }

  const rawTo = sp.get("to")
  const lowerBound = clampIsoBound(
    isoDatePlus(today, -MAX_WINDOW_DISTANCE_DAYS)
  )
  const upperBound = clampIsoBound(isoDatePlus(today, MAX_WINDOW_DISTANCE_DAYS))

  // Check the from side before deriving the default `to`: the default is
  // `from + defaultToDays`, which overflows into the extended-year form near
  // MAX_ISO_DATE. An out-of-range `from` is necessarily too far, so no
  // arithmetic runs on it.
  if (from < lowerBound || from > upperBound) {
    return windowTooFar()
  }

  const to =
    rawTo ??
    (opts ? clampIsoBound(isoDatePlus(from, opts.defaultToDays)) : null)
  if (to === null || !isValidIsoDate(to)) {
    return {
      ok: false,
      error: "invalid_window",
      message: "from/to must be ISO dates",
    }
  }

  if (from > to) {
    return {
      ok: false,
      error: "invalid_window",
      message: "from must not be after to",
    }
  }

  if (to > upperBound) {
    return windowTooFar()
  }

  // A from near MAX_ISO_DATE overflows this bound; the representable tail is
  // necessarily shorter than the width cap, so an unrepresentable bound means
  // "inside the cap".
  const widthEnd = isoDatePlus(from, MAX_OCCURRENCE_WINDOW_DAYS)
  if (isValidIsoDate(widthEnd) && widthEnd < to) {
    return {
      ok: false,
      error: "window_too_large",
      message: `window must not exceed ${MAX_OCCURRENCE_WINDOW_DAYS} days`,
    }
  }

  return { ok: true, from, to }
}
