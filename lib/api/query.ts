/**
 * Shared query-parameter contracts for the list/window routes (ADR-0037).
 *
 * Server-only. The helpers reproduce the existing route semantics exactly:
 * lenient pagination (parseInt permissiveness; an invalid page falls back to
 * 1, while an unrepresentable OFFSET yields an empty page — guarded in
 * lib/pagination.ts), strict digits-only ids, and the calendar window
 * precedence (from → from-distance → to → order → to-distance → width).
 */
import {
  DATE_RANGE_TOO_LARGE_MESSAGE,
  isoDatePlus,
  isValidIsoDate,
  MAX_ISO_DATE,
  MIN_ISO_DATE,
  monthSpanExceedsCap,
} from "@/lib/dates"

export function positiveInt(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/**
 * Positive page number, 1 for missing/malformed/overflowing input. Pages
 * above 2^53 are accepted and echoed: SQLite can bind their integral offsets
 * up to 2^63, and beyond that `paginate` answers an empty page. `parseInt`
 * stays deliberately lenient (`"3abc"` → 3, `"1e18"` → 1).
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

export type DateRangeErrorCode = "invalid_date" | "range_too_large"

export type DateRangeParse =
  | { ok: true; dateFrom?: string; dateTo?: string }
  | { ok: false; error: DateRangeErrorCode; message: string }

/**
 * Shared date-filter contract for the list routes. `/api/analytics` and
 * `/api/transactions` parse the same FilterBar params, so they must accept and
 * reject exactly the same queries.
 *
 * Only an explicitly requested two-sided range is capped: that is the one span
 * a caller can inflate arbitrarily. A one-sided or absent bound is
 * data-derived, so the engine bounds its zero-fill gracefully instead of
 * rejecting the request (see `computeAnalytics`); pre-checking against today
 * would over-reject stale data.
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

  const dateFrom = from.value
  const dateTo = to.value
  if (
    dateFrom !== undefined &&
    dateTo !== undefined &&
    monthSpanExceedsCap(dateFrom, dateTo)
  ) {
    return {
      ok: false,
      error: "range_too_large",
      message: DATE_RANGE_TOO_LARGE_MESSAGE,
    }
  }

  return { ok: true, dateFrom, dateTo }
}

export type WindowErrorCode =
  "invalid_window" | "window_too_far" | "window_too_large"

export type WindowParse =
  | { ok: true; from: string; to: string }
  | { ok: false; error: WindowErrorCode; message: string }

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

/** Shared `window_too_far` result so both distance checks stay in lockstep. */
function windowTooFar(): WindowParse {
  return {
    ok: false,
    error: "window_too_far",
    message: `window must lie within ${MAX_WINDOW_DISTANCE_DAYS} days of today`,
  }
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
 */
export function parseWindow(
  sp: URLSearchParams,
  today: string,
  opts?: { defaultToDays: number }
): WindowParse {
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
  const lowerBound = isoDatePlus(today, -MAX_WINDOW_DISTANCE_DAYS)
  const upperBound = isoDatePlus(today, MAX_WINDOW_DISTANCE_DAYS)

  // Check the from side before deriving the default `to`: the default is
  // `from + defaultToDays`, which overflows into the extended-year form near
  // MAX_ISO_DATE. An out-of-range `from` is necessarily too far, so no
  // arithmetic runs on it.
  if (from < lowerBound || from > upperBound) {
    return windowTooFar()
  }

  const to = rawTo ?? (opts ? isoDatePlus(from, opts.defaultToDays) : null)
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

  if (isoDatePlus(from, MAX_OCCURRENCE_WINDOW_DAYS) < to) {
    return {
      ok: false,
      error: "window_too_large",
      message: `window must not exceed ${MAX_OCCURRENCE_WINDOW_DAYS} days`,
    }
  }

  return { ok: true, from, to }
}
