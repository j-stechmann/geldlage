/**
 * Shared query-parameter contracts for the list/window routes (ADR-0037).
 *
 * Server-only. The helpers reproduce the existing route semantics exactly:
 * lenient pagination (parseInt permissiveness, unsafe OFFSET → page 1),
 * strict digits-only ids, and the calendar window precedence
 * (from → to → order → distance → width).
 */
import { isValidIsoDate, isoDatePlus } from "@/lib/dates"

export function positiveInt(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/**
 * Page number whose OFFSET stays a safe integer. A page that is itself safe
 * can still produce an unsafe `(page - 1) * pageSize`, which better-sqlite3
 * binds as a REAL — an unhandled "datatype mismatch" 500 once that REAL
 * leaves SQLite's int64 range. Keep both representable; an unsafe page falls
 * back to 1.
 */
export function safePage(raw: string | null, pageSize: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  if (!Number.isSafeInteger(n) || n <= 0) return 1
  return (n - 1) * pageSize <= Number.MAX_SAFE_INTEGER ? n : 1
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
  return { page: safePage(sp.get("page"), pageSize), pageSize, paginated }
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

/**
 * Shared calendar-window contract. Distance cap runs before the width cap:
 * expansion walks rrule from dtstart (no seek), and the width cap's own
 * isoDatePlus arithmetic overflows near year 9999. Validating `from` before
 * deriving the default `to` keeps a malformed `from` a 400, not a 500.
 */
export function parseWindow(
  sp: URLSearchParams,
  today: string,
  opts: { fromDefault: "today" | "required"; toDefaultDays: number | null }
): WindowParse {
  const rawFrom = sp.get("from")
  const from = rawFrom ?? (opts.fromDefault === "today" ? today : null)
  if (from === null || !isValidIsoDate(from)) {
    return {
      ok: false,
      error: "invalid_window",
      message: "from/to must be ISO dates",
    }
  }

  const rawTo = sp.get("to")
  const to =
    rawTo ??
    (opts.toDefaultDays !== null ? isoDatePlus(from, opts.toDefaultDays) : null)
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

  const lowerBound = isoDatePlus(today, -MAX_WINDOW_DISTANCE_DAYS)
  const upperBound = isoDatePlus(today, MAX_WINDOW_DISTANCE_DAYS)
  if (from < lowerBound || to > upperBound) {
    return {
      ok: false,
      error: "window_too_far",
      message: `window must lie within ${MAX_WINDOW_DISTANCE_DAYS} days of today`,
    }
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
