/**
 * Recurrence engine for planned transactions (ADR-0035).
 *
 * Plans store a bare RFC 5545 RRULE value (or NULL for one-offs) plus a
 * DTSTART date. This module owns validation (allowlist + caps so expansion
 * is always bounded) and window expansion.
 *
 * Expansion anchors every date at **noon UTC**: rrule computes on the UTC
 * clock, which has no DST — a noon anchor survives month ends / leap days on
 * either side without off-by-one drift, and the ISO dates handed back are
 * read from the same UTC parts. Nothing here touches local time; the client
 * renders occurrences from the ISO strings independently.
 *
 * Monthly/yearly BYMONTHDAY anchors that short months cannot hold (positive
 * days 29–31) CLAMP to the month's last day instead of skipping the month:
 * money due on the 31st is still due in February (ADR-0035, amended for
 * issue #104). Only plain day-of-month rules clamp; BYDAY/BYSETPOS shapes
 * keep rrule's intersection semantics. See `dayOfMonthClamp`.
 */
import { RRule, rrulestr } from "rrule"

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleValidationError"
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Last calendar day of a 1-based month (UTC calendar). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** "YYYY-MM-DD" from UTC calendar parts (year 1900–9999). */
function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** True for "YYYY-MM-DD" names of real calendar days (incl. leap years). */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const [y, m, d] = s.split("-").map(Number)
  if (m < 1 || m > 12) return false
  return d >= 1 && d <= daysInMonth(y, m)
}

/** Noon UTC instant of an ISO date — see module doc. */
export function noonUtc(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12))
}

/** ISO date exactly `days` days from an ISO date (UTC calendar arithmetic). */
export function isoDatePlus(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10)
}

/** ISO date (UTC parts) of a noon-anchored instant. */
function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Highest storable ISO date. All dates (dtstart, windows, expansion output)
 * are plain 4-digit-year "YYYY-MM-DD"; for instants at/after year 10000
 * toISOString() switches to the extended six-digit form ("+010001-…"),
 * whose slice-based day extraction truncates into strings noonUtc cannot
 * parse (Invalid Date → rrule.between throws). dtstart above this bound
 * is already rejected by validation, so occurrence horizons clamp here.
 * Exported so consumers that WALK occurrence dates (the dialog's 3-slot
 * preview) can stop at the same boundary — a cursor past it is not a
 * comparable ISO date.
 */
export const MAX_ISO_DATE = "9999-12-31"

/** Rung window end, clamped at the last storable ISO date. */
function ladderWindowEnd(
  y: number,
  m: number,
  d: number,
  days: number
): string {
  const end = new Date(Date.UTC(y, m - 1, d + days, 12))
  return end.getUTCFullYear() > 9999 ? MAX_ISO_DATE : isoOf(end)
}

/**
 * Parsed shape of a month-end-clamping rule: a MONTHLY/YEARLY rule whose
 * BYMONTHDAY anchors include a day (29–31) that short months cannot hold.
 * Such a rule fires on the month's last day instead of skipping the month —
 * money due on the 31st is still due in February.
 *
 * Only plain day-of-month rules qualify. BYDAY/BYSETPOS intersect/re-select
 * the expanded set, where "the selected day does not exist" is a filter
 * result rather than a missing due date; those keep RRULE semantics.
 */
interface DayOfMonthClamp {
  /** RRule.MONTHLY or RRule.YEARLY. */
  freq: number
  interval: number
  /** 1-based BYMONTH list, sorted; null = every month. */
  months: number[] | null
  /** BYMONTHDAY values, including negative ones (mapped from month end). */
  days: number[]
  count: number | null
  /** Inclusive UNTIL day (occurrences are noon-anchored, so dates compare). */
  untilIso: string | null
}

/**
 * Detect a clampable monthly/yearly BYMONTHDAY rule. Returns null for every
 * other shape, which then expands through rrule unchanged.
 */
function dayOfMonthClamp(parsed: RRule): DayOfMonthClamp | null {
  const opts = parsed.origOptions as {
    freq?: number
    interval?: number
    bymonthday?: number | number[] | null
    bymonth?: number | number[] | null
    byweekday?: unknown
    bysetpos?: unknown
    count?: number | null
    until?: Date | null
  }
  if (opts.freq !== RRule.MONTHLY && opts.freq !== RRule.YEARLY) return null
  if (opts.byweekday != null || opts.bysetpos != null) return null
  if (opts.bymonthday == null) return null
  const rawDays = Array.isArray(opts.bymonthday)
    ? opts.bymonthday
    : [opts.bymonthday]
  const days = rawDays.filter(
    (d): d is number => typeof d === "number" && Number.isInteger(d)
  )
  // Only 29–31 can exceed a month's length; smaller days always exist.
  if (!days.some((d) => d >= 29 && d <= 31)) return null
  const rawMonths =
    opts.bymonth == null
      ? []
      : Array.isArray(opts.bymonth)
        ? opts.bymonth
        : [opts.bymonth]
  const months = rawMonths
    .filter((m): m is number => typeof m === "number" && Number.isInteger(m))
    .filter((m) => m >= 1 && m <= 12)
    .filter((m, i, arr) => arr.indexOf(m) === i)
    .sort((a, b) => a - b)
  // expandOccurrenceDates rejects corrupt INTERVAL/COUNT rows before this
  // detection runs, so a clampable rule always carries valid end conditions.
  return {
    freq: opts.freq,
    interval:
      typeof opts.interval === "number" && opts.interval >= 1
        ? opts.interval
        : 1,
    months: opts.bymonth == null ? null : months,
    days,
    count: typeof opts.count === "number" ? opts.count : null,
    untilIso: opts.until instanceof Date ? isoOf(opts.until) : null,
  }
}

/**
 * Expand a clampable rule arithmetically. Month-by-month expansion is both
 * simpler and cheaper than post-processing rrule output: the clamp can add
 * a date rrule never yields (a month the underlying rule considers empty),
 * and COUNT must count clamped occurrences, not rrule's skipped months.
 */
function expandDayOfMonthClamp(
  dtstart: string,
  spec: DayOfMonthClamp,
  w: { from: string; to: string },
  cap: number
): string[] {
  const [startYear, startMonth] = dtstart.split("-").map(Number)
  const [fromYear, fromMonth] = w.from.split("-").map(Number)
  const [toYear, toMonth] = w.to.split("-").map(Number)
  const out: string[] = []
  let emitted = 0

  const months: Array<[number, number]> = []
  if (spec.freq === RRule.MONTHLY) {
    const startIndex = startYear * 12 + (startMonth - 1)
    const fromIndex = fromYear * 12 + (fromMonth - 1)
    const toIndex = toYear * 12 + (toMonth - 1)
    // Without COUNT the window can start the scan; with COUNT every earlier
    // occurrence has to be counted from dtstart.
    const begin =
      spec.count === null ? Math.max(startIndex, fromIndex) : startIndex
    for (let index = begin; index <= toIndex; index++) {
      if ((index - startIndex) % spec.interval !== 0) continue
      const year = Math.floor(index / 12)
      const month = (index % 12) + 1
      if (spec.months !== null && !spec.months.includes(month)) continue
      months.push([year, month])
    }
  } else {
    const begin =
      spec.count === null ? Math.max(startYear, fromYear) : startYear
    for (let year = begin; year <= toYear; year++) {
      if ((year - startYear) % spec.interval !== 0) continue
      // YEARLY;BYMONTHDAY without BYMONTH repeats the day in every month.
      for (const month of spec.months ?? [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]) {
        months.push([year, month])
      }
    }
  }

  for (const [year, month] of months) {
    const last = daysInMonth(year, month)
    const days = new Set<number>()
    for (const day of spec.days) {
      if (day >= 1 && day <= 31) {
        days.add(Math.min(day, last))
      } else if (day <= -1 && day >= -31) {
        const resolved = last + 1 + day
        if (resolved >= 1) days.add(resolved)
      }
    }
    for (const day of [...days].sort((a, b) => a - b)) {
      const iso = isoDate(year, month, day)
      if (iso < dtstart) continue
      if (spec.untilIso !== null && iso > spec.untilIso) return out
      if (spec.count !== null) emitted++
      if (iso >= w.from && iso <= w.to) {
        out.push(iso)
        if (out.length >= cap) return out
      }
      if (spec.count !== null && emitted >= spec.count) return out
    }
  }
  return out
}

/** rrule's numeric freq constants, allowlisted (SECONDLY/MINUTELY rejected). */
const ALLOWED_FREQ: Record<string, number> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
}

/**
 * Stored-rule length cap (chars, checked on the normalized text). The
 * allowlisted vocabulary tops out at a few hundred chars (all 62 signed
 * BYMONTHDAY tokens + all 12 BYMONTH tokens + base parts ≈ 350), while the
 * rrule column feeds size-bounded surfaces: the agent's list summaries
 * share one ~4000-char tool-result cap and plan JSON views/badges render
 * the rule verbatim. Anything longer is not a recurrence — reject.
 */
export const MAX_RULE_LENGTH = 1000

/** BY* parts a stored rule may use; anything else is rejected. */
const ALLOWED_PARTS = new Set([
  "freq",
  "interval",
  "count",
  "until",
  "byweekday",
  "bymonthday",
  "bymonth",
  "bysetpos",
  "wkst",
])

const MAX_INTERVAL = 100
const MAX_COUNT = 366

/**
 * Normalize a user-supplied rule before parsing: uppercase, drop the
 * "RRULE:" prefix, compact UNTIL datetimes (rrule's parser only accepts
 * YYYYMMDDTHHMMSSZ — dashed RFC forms fail outright), lift date-only and
 * every SUB-NOON UNTIL time to noon. A sub-noon UNTIL (midnight, 06:00,
 * …) would silently drop that final noon-anchored occurrence — all-day
 * plans end on the named day; times ≥ 12:00:00 already include it.
 * Floating (no-Z) datetimes are canonicalized with Z — rrule parses them
 * as UTC anyway.
 */
export function normalizeRuleInput(input: string): string {
  let raw = input
    .trim()
    .toUpperCase()
    .replace(/^RRULE:/, "")
  raw = raw.replace(
    /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/,
    "$1$2$3T$4$5$6Z"
  )
  raw = raw.replace(/(UNTIL=)(\d{4})-(\d{2})-(\d{2})(?!T)/g, "$1$2$3$4")
  raw = raw.replace(/(UNTIL=)(\d{8})(?!T)/g, "$1$2T120000Z")
  // sub-noon datetime UNTIL (00:00:00–11:59:59, Z or floating): the
  // noon-anchored occurrence on that day compares AFTER it and would be
  // excluded — the same failure the date-only lift guards against. Stored
  // pre-fix rules are lifted here at read time too.
  raw = raw.replace(
    /(UNTIL=\d{8}T)(\d{2})(\d{2})(\d{2})(Z?)/g,
    (_m, pre: string, hh: string, mm: string, ss: string, z: string) =>
      Number(hh) < 12 ? `${pre}120000Z` : `${pre}${hh}${mm}${ss}${z || "Z"}`
  )
  return raw
}

/**
 * Validate a user-supplied RRULE and return the canonical stored form
 * (uppercase, re-serialized by rrule, no "RRULE:" prefix, no DTSTART —
 * dtstart lives in its own column). Throws RuleValidationError.
 */
export function validateRrule(input: string): string {
  const raw = normalizeRuleInput(input)
  if (raw === "") {
    throw new RuleValidationError("empty rule")
  }
  if (raw.length > MAX_RULE_LENGTH) {
    throw new RuleValidationError(
      `rule too long (max ${MAX_RULE_LENGTH} chars)`
    )
  }
  // Full RFC texts (DTSTART/EXDATE lines, multi-line) are rejected — dtstart
  // lives in its own column; a pasted "DTSTART:…" line must never
  // transparently move the plan's first occurrence.
  if (
    raw.includes("\n") ||
    raw.startsWith("DTSTART") ||
    raw.includes("EXDATE") ||
    raw.includes("RDATE")
  ) {
    throw new RuleValidationError("single rule only")
  }
  // TZID needs its own textual guard: rrule's string parser SILENTLY drops
  // the part (it never reaches the origOptions-based unsupported check
  // below), so "TZID=Europe/Berlin;FREQ=…" would be stored as if the user
  // had never written it. Canonicalization must reject, never strip
  // semantics (tool descriptions promise rejection for everything
  // non-allowlisted — verified no allowlisted part contains "TZID").
  if (raw.includes("TZID=")) {
    throw new RuleValidationError("unsupported part: TZID")
  }
  let rule: RRule
  try {
    const parsed = rrulestr(raw, { forceset: false })
    // Belt-and-suspenders: the string guards above already reject line-based
    // RFC texts (DTSTART/EXDATE/RDATE) and multi-rule input; anything that
    // still parses into a set is rejected here. An inline ";DTSTART=…" part
    // parses into an RRule and is caught further down as an unsupported part.
    if (!(parsed instanceof RRule)) {
      throw new RuleValidationError("single rule only")
    }
    rule = parsed
  } catch (err) {
    if (err instanceof RuleValidationError) throw err
    throw new RuleValidationError("unparseable rule")
  }

  const opts = rule.origOptions as Record<string, unknown>
  // origOptions carries prototype defaults (cache/tzid, value undefined) on
  // every instance — only ACTUALLY provided parts count. dtstart is NOT
  // exempted: rrule parses an inline ";DTSTART=…" into a real Date there, and
  // it must fail loudly like every other unsupported part — a dropped DTSTART
  // would otherwise read back as a plan anchored somewhere else (dtstart
  // lives in the plan's own column).
  const provided = Object.keys(opts).filter(
    (k) =>
      opts[k] !== undefined &&
      opts[k] !== null &&
      !["cache", "tzid"].includes(k)
  )
  const unknown = provided.filter((k) => !ALLOWED_PARTS.has(k))
  if (unknown.length > 0) {
    throw new RuleValidationError(`unsupported part: ${unknown.join(", ")}`)
  }
  if (
    typeof opts.freq !== "number" ||
    !Object.values(ALLOWED_FREQ).includes(opts.freq)
  ) {
    throw new RuleValidationError(
      "freq must be DAILY, WEEKLY, MONTHLY or YEARLY"
    )
  }
  // RFC 5545: ordinal BYDAY values ("1FR", "-1SU") are only defined for
  // MONTHLY/YEARLY — rrule silently IGNORES the ordinal for DAILY/WEEKLY
  // (WEEKLY;BYDAY=1MO behaves as plain WEEKLY;BYDAY=MO), so storing such a
  // rule would bake a silent semantic lie into an otherwise validated plan.
  if (
    (opts.freq === RRule.DAILY || opts.freq === RRule.WEEKLY) &&
    opts.byweekday !== undefined &&
    opts.byweekday !== null
  ) {
    const tokens = Array.isArray(opts.byweekday)
      ? opts.byweekday
      : [opts.byweekday]
    const hasOrdinal = tokens.some(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        (t as { n?: number | null }).n != null
    )
    if (hasOrdinal) {
      throw new RuleValidationError(
        "ordinal BYDAY (e.g. 1FR) requires MONTHLY or YEARLY"
      )
    }
  }
  const interval = opts.interval ?? 1
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > MAX_INTERVAL
  ) {
    throw new RuleValidationError(`interval must be 1–${MAX_INTERVAL}`)
  }
  if (opts.count !== undefined && opts.count !== null) {
    if (
      typeof opts.count !== "number" ||
      !Number.isInteger(opts.count) ||
      opts.count < 1 ||
      opts.count > MAX_COUNT
    ) {
      throw new RuleValidationError(`count must be 1–${MAX_COUNT}`)
    }
    if (opts.until) {
      throw new RuleValidationError("count and until are mutually exclusive")
    }
  }
  // bysetpos only makes sense together with byweekday/bymonthday/bymonth —
  // rrule itself errors on lone bysetpos at expand time; reject up front.
  if (opts.bysetpos !== undefined && opts.bysetpos !== null) {
    if (
      !["byweekday", "bymonthday", "bymonth"].some(
        (k) => opts[k] !== undefined && opts[k] !== null
      )
    ) {
      throw new RuleValidationError(
        "bysetpos requires byweekday, bymonthday or bymonth"
      )
    }
  }
  return ruleToString(opts)
}

/**
 * Canonical serialization of validated options (used by validateRrule and
 * tests): fresh RRule around exactly those options — drops cache/dtstart
 * noise and yields rrule's canonical uppercase text. UNTIL keeps the exact
 * instant of the parsed options: date-only / sub-noon inputs are already
 * lifted to noon by normalizeRuleInput BEFORE parsing, so the stored form
 * preserves that lifted time verbatim (e.g. T120000Z); expansion re-runs
 * normalizeRuleInput at read time, which is idempotent on lifted values.
 */
function ruleToString(opts: Record<string, unknown>): string {
  const rest = { ...opts }
  delete rest.cache
  delete rest.dtstart
  const serialized = new RRule(rest as never).toString()
  // rrule emits "RRULE:FREQ=…" in some environments and bare parts in
  // others (version-dependent) — normalize to the bare form we store. A
  // "+" (rrule's own "+1FR" ordinal rendering) is normalized away; the
  // parts vocabulary otherwise carries no "+" literals.
  return serialized
    .replace(/^RRULE:/, "")
    .replace(/\+/g, "")
    .toUpperCase()
}

/** True when the rule string is empty-ish → treat plan as one-off. */
export function isEmptyRule(input: string | null | undefined): boolean {
  return input === null || input === undefined || input.trim() === ""
}

/**
 * Occurrence dates (ISO, ascending) of a plan inside [from, to], inclusive.
 * One-off plans (rrule null/empty) occur exactly on dtstart. Bounded by the
 * occurrence cap — a pathological rule can never blow up a request.
 *
 * The rule is rebuilt with an EXPLICIT dtstart: rrulestr alone would default
 * dtstart to "now", silently emptying every window before today. Plain
 * monthly/yearly BYMONTHDAY rules with a 29–31 anchor take the clamping path
 * (see `dayOfMonthClamp`); every other shape expands through rrule.
 */
export function expandOccurrenceDates(
  dtstart: string,
  rruleText: string | null,
  w: { from: string; to: string },
  cap = 2000
): string[] {
  if (cap <= 0) return []
  if (isEmptyRule(rruleText)) {
    return dtstart >= w.from && dtstart <= w.to ? [dtstart] : []
  }
  try {
    const parsed = rrulestr(normalizeRuleInput(rruleText as string), {
      forceset: false,
    })
    if (!(parsed instanceof RRule)) return []
    // Defence in depth for corrupt rows: validateRrule rejects these, but
    // rrule itself hangs on a non-positive/fractional INTERVAL (only exactly
    // 0 short-circuits) and ignores invalid COUNTs. Reject before ANY
    // expansion path so a pathological row can never block a read route.
    const rawOpts = parsed.origOptions as {
      interval?: number
      count?: number | null
    }
    const rawInterval = rawOpts.interval ?? 1
    if (!Number.isInteger(rawInterval) || rawInterval < 1) return []
    if (
      rawOpts.count != null &&
      (!Number.isInteger(rawOpts.count) || rawOpts.count < 1)
    ) {
      return []
    }
    const after = noonUtc(w.from)
    const before = noonUtc(w.to)
    // A rule live at write time expires naturally later (UNTIL passes) —
    // and every read after that would walk rrule occurrence-by-occurrence
    // from dtstart to the window for one guaranteed-empty result (rrule has
    // no seek; a daily plan with a years-old dtstart costs tens of
    // thousands of iterations per window, several hundred ms for a
    // 1900-dtstart one). An UNTIL strictly before the window start proves
    // the same empty result without expanding. Occurrences sit at noon and
    // normalization keeps every UNTIL at-or-after noon of its own day, so
    // the instant compare is exact; a window opening ON the end day (or
    // earlier) still expands below and keeps the final occurrence.
    const until = (parsed.origOptions as { until?: Date | null }).until
    if (until instanceof Date && until.getTime() < after.getTime()) {
      return []
    }
    const clamp = dayOfMonthClamp(parsed)
    if (clamp !== null) {
      return expandDayOfMonthClamp(dtstart, clamp, w, cap)
    }
    const rule = new RRule({
      ...parsed.origOptions,
      dtstart: noonUtc(dtstart),
    } as never)
    return rule
      .between(after, before, true)
      .slice(0, cap)
      .map(isoOf)
      .filter((iso, i, arr) => i === 0 || arr[i - 1] !== iso)
  } catch {
    // Every stored rule is validated at write time, so this is
    // belt-and-suspenders: a pathological row degrades to "no occurrences"
    // instead of taking a read route (plan list, occurrences, forecast,
    // calendar) down with it.
    return []
  }
}

/**
 * Next occurrence date at-or-after `afterIso` (inclusive — `afterIso` itself
 * counts), or null. Scans a
 * growing window (first attempt the default horizon, then wider) so an
 * unbounded daily rule cannot scan forever — while a live but *sparse* rule
 * (large INTERVAL, 5th-weekday ordinals, BYDAY+BYMONTHDAY intersections)
 * still finds its real next date instead of a misleading null. The ladder is
 * bounded: a rule that truly never fires again (expired UNTIL, exhausted
 * COUNT) costs at most five bounded scans. The closing rung covers the
 * common sparse shapes: a plain MONTHLY/YEARLY day-of-month rule (the
 * clamping path) fires at least once per INTERVAL (≤100 years), and a
 * century-cadence weekday intersection can span one Gregorian 400-year
 * cycle (146,097 days, e.g. a Feb-29-that-is-a-Tuesday rule anchored on a
 * century cadence: 2000 → 2400). A large INTERVAL combined with a
 * calendar-dependent BYDAY/BYSETPOS filter, and raw DAILY/WEEKLY BY*
 * filters, can space matches thousands of years apart (e.g.
 * YEARLY;INTERVAL=97;BYMONTH=2;BYMONTHDAY=29;BYDAY=TU); past the ladder they
 * answer null instead of scanning unboundedly. Dense rules are found on the
 * first rung, only the pathological sparse cadences pay the full ladder.
 *
 * Rung ends clamp at MAX_ISO_DATE: an unclamped end would cross into the
 * extended-year form and truncate into an Invalid Date (between throws →
 * every rung answers "no occurrences" — a live late-9999 plan would read
 * as dead). Once clamped, rungs cannot widen the window anymore, so a
 * repeated end short-circuits to null instead of re-scanning the same
 * span for the remaining rungs; an occurrence beyond the storable range
 * cannot be handed back as a 4-digit ISO date, making null the honest
 * answer there.
 */
const NEXT_HORIZON_LADDER = [400, 1600, 6400, 25_600, 147_000]

export function nextOccurrenceDate(
  dtstart: string,
  rruleText: string | null,
  afterIso: string
): string | null {
  const from = dtstart > afterIso ? dtstart : afterIso
  const [y, m, d] = from.split("-").map(Number)
  let prevTo: string | null = null
  for (const horizonDays of NEXT_HORIZON_LADDER) {
    const to = ladderWindowEnd(y, m, d, horizonDays)
    if (to === prevTo) return null
    prevTo = to
    const dates = expandOccurrenceDates(dtstart, rruleText, { from, to }, 1)
    if (dates.length > 0) return dates[0]
  }
  return null
}
