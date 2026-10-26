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
 */
import { RRule, rrulestr } from "rrule"

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuleValidationError"
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True for "YYYY-MM-DD" names of real calendar days (incl. leap years). */
export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const [y, m, d] = s.split("-").map(Number)
  if (m < 1 || m > 12) return false
  // last calendar day of month m (m is 1-based here)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return d >= 1 && d <= lastDay
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

/** rrule's numeric freq constants, allowlisted (SECONDLY/MINUTELY rejected). */
const ALLOWED_FREQ: Record<string, number> = {
  DAILY: RRule.DAILY,
  WEEKLY: RRule.WEEKLY,
  MONTHLY: RRule.MONTHLY,
  YEARLY: RRule.YEARLY,
}

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
 * YYYYMMDDTHHMMSSZ — dashed RFC forms fail outright) and lift date-only
 * UNTIL to noon (a midnight UNTIL would silently drop that final
 * noon-anchored occurrence).
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
  let rule: RRule
  try {
    const parsed = rrulestr(raw, { forceset: false })
    // DTSTART/EXDATE lines or multi-rule input parse into a set — reject.
    if (!(parsed instanceof RRule)) {
      throw new RuleValidationError("single rule only")
    }
    rule = parsed
  } catch (err) {
    if (err instanceof RuleValidationError) throw err
    throw new RuleValidationError("unparseable rule")
  }

  const opts = rule.origOptions as Record<string, unknown>
  // origOptions carries prototype defaults (dtstart/tzid/cache, value
  // undefined) on every instance — only ACTUALLY provided parts count
  const provided = Object.keys(opts).filter(
    (k) =>
      opts[k] !== undefined &&
      opts[k] !== null &&
      !["cache", "dtstart", "tzid"].includes(k)
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
 * noise and yields rrule's canonical uppercase text (UNTIL becomes
 * YYYYMMDDT000000Z-style UTC datetime, date-only input normalized).
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
 * dtstart to "now", silently emptying every window before today.
 */
export function expandOccurrenceDates(
  dtstart: string,
  rruleText: string | null,
  w: { from: string; to: string },
  cap = 2000
): string[] {
  if (isEmptyRule(rruleText)) {
    return dtstart >= w.from && dtstart <= w.to ? [dtstart] : []
  }
  try {
    const parsed = rrulestr(normalizeRuleInput(rruleText as string), {
      forceset: false,
    })
    if (!(parsed instanceof RRule)) return []
    const rule = new RRule({
      ...parsed.origOptions,
      dtstart: noonUtc(dtstart),
    } as never)
    const after = noonUtc(w.from)
    const before = noonUtc(w.to)
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
 * Next occurrence date strictly at-or-after `afterIso`, or null. Scans a
 * growing window (first attempt the default horizon, then wider) so an
 * unbounded daily rule cannot scan forever — while a live but *sparse* rule
 * (large INTERVAL, 5th-weekday ordinals, leap-day rules) still finds its
 * real next date instead of a misleading null. The ladder is bounded: a
 * rule that truly never fires again (expired UNTIL, exhausted COUNT) costs
 * at most four bounded scans.
 */
const NEXT_HORIZON_LADDER = [400, 1600, 6400, 25_600]

export function nextOccurrenceDate(
  dtstart: string,
  rruleText: string | null,
  afterIso: string
): string | null {
  const from = dtstart > afterIso ? dtstart : afterIso
  const [y, m, d] = from.split("-").map(Number)
  for (const horizonDays of NEXT_HORIZON_LADDER) {
    const to = isoOf(new Date(Date.UTC(y, m - 1, d + horizonDays, 12)))
    const dates = expandOccurrenceDates(dtstart, rruleText, { from, to }, 1)
    if (dates.length > 0) return dates[0]
  }
  return null
}
