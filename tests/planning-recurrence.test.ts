import { describe, it, expect } from "vitest"
import {
  expandOccurrenceDates,
  isValidIsoDate,
  isoDatePlus,
  isEmptyRule,
  MAX_RULE_LENGTH,
  nextOccurrenceDate,
  RuleValidationError,
  validateRrule,
} from "@/lib/planning/recurrence"

function expectRuleError(input: string, message?: string) {
  expect(() => validateRrule(input)).toThrow(RuleValidationError)
  if (message) {
    expect(() => validateRrule(input)).toThrow(message)
  }
}

describe("isValidIsoDate", () => {
  it("accepts real calendar days", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true) // leap year
    expect(isValidIsoDate("2025-02-28")).toBe(true)
    expect(isValidIsoDate("2026-12-31")).toBe(true)
  })
  it("rejects impossible days, months and shapes", () => {
    expect(isValidIsoDate("2026-02-29")).toBe(false) // not a leap year
    expect(isValidIsoDate("2025-02-29")).toBe(false)
    expect(isValidIsoDate("2026-13-01")).toBe(false)
    expect(isValidIsoDate("2026-00-10")).toBe(false)
    expect(isValidIsoDate("2026-1-2")).toBe(false)
    expect(isValidIsoDate("26-01-02")).toBe(false)
    expect(isValidIsoDate("")).toBe(false)
  })
})

describe("isoDatePlus", () => {
  it("shifts across month ends", () => {
    expect(isoDatePlus("2026-01-31", 1)).toBe("2026-02-01")
    expect(isoDatePlus("2024-02-28", 1)).toBe("2024-02-29") // leap
    expect(isoDatePlus("2026-12-31", 1)).toBe("2027-01-01")
  })
})

describe("validateRrule", () => {
  it("accepts the allowlisted parts and canonicalizes", () => {
    expect(validateRrule("freq=monthly;interval=1;bymonthday=1")).toBe(
      "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1"
    )
    expect(validateRrule("freq=monthly;bymonthday=1")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=1"
    )
    expect(validateRrule("RRULE:FREQ=WEEKLY;BYDAY=MO,TU")).toBe(
      "FREQ=WEEKLY;BYDAY=MO,TU"
    )
    expect(validateRrule("FREQ=MONTHLY;BYDAY=1FR")).toBe(
      "FREQ=MONTHLY;BYDAY=1FR"
    )
    expect(validateRrule("FREQ=YEARLY;BYMONTH=1,6;BYMONTHDAY=15")).toBe(
      "FREQ=YEARLY;BYMONTH=1,6;BYMONTHDAY=15"
    )
  })

  it("rejects non-allowlisted parts", () => {
    expectRuleError("FREQ=SECONDLY")
    expectRuleError("FREQ=MINUTELY")
    expectRuleError("FREQ=HOURLY")
    expectRuleError("FREQ=DAILY;BYHOUR=12")
    expectRuleError("FREQ=DAILY;BYMINUTE=30")
    expectRuleError("FREQ=DAILY;BYSECOND=10")
    expectRuleError("FREQ=WEEKLY;BYWEEKNO=10")
    expectRuleError("FREQ=YEARLY;BYYEARDAY=100")
    expectRuleError("FREQ=DAILY;EXDATE=20260101T120000Z")
    expectRuleError("garbage")
    expectRuleError("")
  })

  it("rejects out-of-bound interval and count", () => {
    expectRuleError("FREQ=DAILY;INTERVAL=0")
    expectRuleError("FREQ=DAILY;INTERVAL=101")
    expectRuleError("FREQ=DAILY;INTERVAL=2.5")
    expectRuleError("FREQ=DAILY;COUNT=0")
    expectRuleError("FREQ=DAILY;COUNT=367")
    expect(() => validateRrule("FREQ=DAILY;INTERVAL=100")).not.toThrow()
    expect(() => validateRrule("FREQ=DAILY;COUNT=366")).not.toThrow()
  })

  it("rejects count and until together", () => {
    expectRuleError("FREQ=DAILY;COUNT=5;UNTIL=2030-01-15T12:00:00Z")
  })

  it("rejects lone bysetpos", () => {
    expectRuleError("FREQ=MONTHLY;BYSETPOS=1")
    expect(() =>
      validateRrule("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1")
    ).not.toThrow()
  })

  it("rejects ordinal BYDAY for DAILY/WEEKLY (RFC: ordinals are MONTHLY/YEARLY-only)", () => {
    // rrule silently ignores the ordinal there (WEEKLY;BYDAY=1MO behaves as
    // every Monday) — storing it would bake a semantic lie into the plan
    expectRuleError("FREQ=WEEKLY;BYDAY=1MO")
    expectRuleError("FREQ=WEEKLY;BYDAY=-1SU")
    expectRuleError("FREQ=DAILY;BYDAY=1FR")
    // non-ordinal weekday filtering stays allowed on DAILY/WEEKLY …
    expect(() => validateRrule("FREQ=DAILY;BYDAY=MO")).not.toThrow()
    expect(() => validateRrule("FREQ=WEEKLY;BYDAY=MO,TU")).not.toThrow()
    // … and ordinals keep working where they belong
    expect(() => validateRrule("FREQ=MONTHLY;BYDAY=1FR")).not.toThrow()
    expect(() => validateRrule("FREQ=MONTHLY;BYDAY=-1FR")).not.toThrow()
    expect(() => validateRrule("FREQ=YEARLY;BYDAY=1MO")).not.toThrow()
  })

  it("rejects rule sets / multiple lines", () => {
    expectRuleError("DTSTART:20260101T120000Z\nRRULE:FREQ=DAILY;COUNT=5")
  })

  it("rejects an inline DTSTART part (dtstart lives in the plan's column)", () => {
    // a semicolon-inline ";DTSTART=…" parses into origOptions as a real Date
    // and must fail loudly like every other unsupported part — a rule that
    // silently dropped it would read back anchored somewhere else (the
    // line-form is covered by the test above)
    expectRuleError(
      "FREQ=DAILY;DTSTART=19970101T000000Z",
      "unsupported part: dtstart"
    )
    expectRuleError("FREQ=DAILY;DTSTART=19970101T000000Z;BYMONTHDAY=1")
    // prototype defaults (dtstart/tzid absent) never trip the provided-part
    // check: plain rules stay accepted
    expect(() => validateRrule("FREQ=DAILY")).not.toThrow()
    expect(() =>
      validateRrule("FREQ=DAILY;UNTIL=20270305T120000Z")
    ).not.toThrow()
  })

  it("rejects oversized rule texts; the maximal legit rule stays accepted", () => {
    // the allowlisted vocabulary tops out at a few hundred chars — beyond
    // the cap the text is payload smuggled through the RRULE parser, not
    // a recurrence
    const legit =
      "FREQ=YEARLY;INTERVAL=100;" +
      "BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;" +
      "BYMONTHDAY=1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,-31"
    expect(legit.length).toBeGreaterThan(100)
    expect(legit.length).toBeLessThan(MAX_RULE_LENGTH)
    expect(validateRrule(legit)).not.toBe("") // accepted below the cap

    const oversized =
      "FREQ=MONTHLY;BYMONTHDAY=" +
      Array.from({ length: MAX_RULE_LENGTH }, () => "1").join(",")
    expect(oversized.length).toBeGreaterThan(MAX_RULE_LENGTH)
    expectRuleError(oversized, "rule too long")
  })
})

describe("expandOccurrenceDates", () => {
  it("one-off plans occur exactly on dtstart", () => {
    expect(
      expandOccurrenceDates("2026-11-03", null, {
        from: "2026-01-01",
        to: "2026-12-31",
      })
    ).toEqual(["2026-11-03"])
    expect(
      expandOccurrenceDates("2026-11-03", null, {
        from: "2026-12-01",
        to: "2026-12-31",
      })
    ).toEqual([])
  })

  it("monthly rules expand across the window", () => {
    const dates = expandOccurrenceDates(
      "2026-01-01",
      "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
      { from: "2026-01-01", to: "2026-03-31" }
    )
    expect(dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"])
  })

  it("monthly day-31 rules SKIP short months (RRULE semantics)", () => {
    const dates = expandOccurrenceDates(
      "2026-01-31",
      "FREQ=MONTHLY;BYMONTHDAY=31",
      { from: "2026-01-01", to: "2026-04-30" }
    )
    // January has 31, February is skipped, March has 31, April is skipped
    expect(dates).toEqual(["2026-01-31", "2026-03-31"])
  })

  it("weekly BYDAY rules expand in-window", () => {
    const dates = expandOccurrenceDates(
      "2026-10-05", // Monday
      "FREQ=WEEKLY;BYDAY=MO",
      { from: "2026-10-01", to: "2026-10-31" }
    )
    expect(dates).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ])
  })

  it("honours UNTIL inclusive with a noon anchor", () => {
    const dates = expandOccurrenceDates(
      "2026-01-01",
      "FREQ=MONTHLY;UNTIL=20260301T120000Z",
      { from: "2026-01-01", to: "2026-06-30" }
    )
    // UNTIL noon == occurrence noon → the March 1 occurrence is included
    expect(dates).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"])
  })

  it("normalizes dashed UNTIL forms (compact is the only form rrule parses)", () => {
    expect(validateRrule("FREQ=MONTHLY;UNTIL=2030-03-15T12:00:00Z")).toBe(
      "FREQ=MONTHLY;UNTIL=20300315T120000Z"
    )
    // date-only UNTIL lifts to NOON — a midnight UNTIL would silently drop
    // the final noon-anchored occurrence
    expect(validateRrule("FREQ=MONTHLY;UNTIL=2030-03-15")).toBe(
      "FREQ=MONTHLY;UNTIL=20300315T120000Z"
    )
    expect(
      expandOccurrenceDates("2030-03-14", "FREQ=DAILY;UNTIL=2030-03-15", {
        from: "2030-03-14",
        to: "2030-03-31",
      })
    ).toEqual(["2030-03-14", "2030-03-15"])
  })

  it("lifts a MIDNIGHT datetime UNTIL to noon — the final day stays included", () => {
    // dashed and compact midnight forms both normalize to the stored noon
    // canonical (a midnight UNTIL excluded the noon-anchored occurrence on
    // the named day — the failure the date-only lift guards against)
    expect(validateRrule("FREQ=MONTHLY;UNTIL=2030-03-15T00:00:00Z")).toBe(
      "FREQ=MONTHLY;UNTIL=20300315T120000Z"
    )
    expect(validateRrule("FREQ=MONTHLY;UNTIL=20300315T000000Z")).toBe(
      "FREQ=MONTHLY;UNTIL=20300315T120000Z"
    )
    // a rule stored pre-fix (midnight in the DB) is lifted at read time
    expect(
      expandOccurrenceDates("2030-03-14", "FREQ=DAILY;UNTIL=20300315T000000Z", {
        from: "2030-03-14",
        to: "2030-03-31",
      })
    ).toEqual(["2030-03-14", "2030-03-15"])
  })

  it("lifts EVERY sub-noon UNTIL time to noon (not just midnight)", () => {
    // 06:00 / 11:30 on the final day sit BEFORE the noon anchor — without
    // the lift the named day's occurrence silently drops
    expect(validateRrule("FREQ=DAILY;UNTIL=20300315T060000Z")).toBe(
      "FREQ=DAILY;UNTIL=20300315T120000Z"
    )
    expect(validateRrule("FREQ=DAILY;UNTIL=20300315T113000Z")).toBe(
      "FREQ=DAILY;UNTIL=20300315T120000Z"
    )
    // floating (no-Z) sub-noon datetimes: rrule parses them as UTC anyway —
    // lifted AND canonicalized with the Z designator
    expect(validateRrule("FREQ=DAILY;UNTIL=20300315T060000")).toBe(
      "FREQ=DAILY;UNTIL=20300315T120000Z"
    )
    // times AT/AFTER noon already include the occurrence — untouched
    expect(validateRrule("FREQ=DAILY;UNTIL=20300315T120000Z")).toBe(
      "FREQ=DAILY;UNTIL=20300315T120000Z"
    )
    expect(validateRrule("FREQ=DAILY;UNTIL=20300315T123045Z")).toBe(
      "FREQ=DAILY;UNTIL=20300315T123045Z"
    )
    expect(validateRrule("FREQ=DAILY;UNTIL=20300315T235959Z")).toBe(
      "FREQ=DAILY;UNTIL=20300315T235959Z"
    )
    // …and the lifted bound keeps the final day's occurrence
    expect(
      expandOccurrenceDates("2030-03-01", "FREQ=DAILY;UNTIL=20300315T060000Z", {
        from: "2030-03-01",
        to: "2030-03-31",
      })
    ).toEqual([
      "2030-03-01",
      "2030-03-02",
      "2030-03-03",
      "2030-03-04",
      "2030-03-05",
      "2030-03-06",
      "2030-03-07",
      "2030-03-08",
      "2030-03-09",
      "2030-03-10",
      "2030-03-11",
      "2030-03-12",
      "2030-03-13",
      "2030-03-14",
      "2030-03-15",
    ])
  })

  it("honours COUNT", () => {
    const dates = expandOccurrenceDates("2026-06-01", "FREQ=MONTHLY;COUNT=2", {
      from: "2026-01-01",
      to: "2030-01-01",
    })
    expect(dates).toEqual(["2026-06-01", "2026-07-01"])
  })

  it("short-circuits an UNTIL expired before the window (same result, no walk)", () => {
    // expiry years before the window: the fast path must return exactly
    // what the slow expansion proves — an empty set. (Without the guard
    // the read walks occurrence-by-occurrence from dtstart; a
    // 1900-dtstart daily plan measured ~0.3 s per window on every
    // list/occurrences/forecast read.)
    expect(
      expandOccurrenceDates("1990-03-01", "FREQ=DAILY;UNTIL=19900310T120000Z", {
        from: "2026-01-01",
        to: "2026-01-31",
      })
    ).toEqual([])
    // the day AFTER expiry is empty too …
    expect(
      expandOccurrenceDates("2026-11-13", "FREQ=DAILY;UNTIL=20261115T120000Z", {
        from: "2026-11-16",
        to: "2026-11-20",
      })
    ).toEqual([])
    // … a window opening ON the end day keeps its final occurrence …
    expect(
      expandOccurrenceDates("2026-11-13", "FREQ=DAILY;UNTIL=20261115T120000Z", {
        from: "2026-11-15",
        to: "2026-11-20",
      })
    ).toEqual(["2026-11-15"])
    // … and rules without UNTIL are untouched by the guard
    expect(
      expandOccurrenceDates("2026-11-13", "FREQ=DAILY", {
        from: "2026-11-16",
        to: "2026-11-20",
      })
    ).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
    ])
  })

  it("windows clip both sides", () => {
    const dates = expandOccurrenceDates("2026-01-01", "FREQ=DAILY", {
      from: "2026-01-10",
      to: "2026-01-12",
    })
    expect(dates).toEqual(["2026-01-10", "2026-01-11", "2026-01-12"])
  })
})

describe("nextOccurrenceDate", () => {
  it("returns the next date at-or-after the boundary", () => {
    expect(
      nextOccurrenceDate(
        "2026-01-01",
        "FREQ=MONTHLY;BYMONTHDAY=1",
        "2026-02-15"
      )
    ).toBe("2026-03-01")
    expect(
      nextOccurrenceDate(
        "2026-01-01",
        "FREQ=MONTHLY;BYMONTHDAY=1",
        "2026-03-01"
      )
    ).toBe("2026-03-01")
  })
  it("one-off plans resolve to dtstart when in the future", () => {
    expect(nextOccurrenceDate("2026-12-24", null, "2026-06-01")).toBe(
      "2026-12-24"
    )
    expect(nextOccurrenceDate("2026-01-01", null, "2026-06-01")).toBeNull()
  })
  it("widens the horizon for sparse live rules (ladder) instead of lying null", () => {
    // MONTHLY;INTERVAL=100: next occurrence ~8 years out — the first 400-day
    // window draws a blank, the ladder is what makes this non-null
    expect(
      nextOccurrenceDate(
        "2026-03-01",
        "FREQ=MONTHLY;INTERVAL=100;BYMONTHDAY=1",
        "2026-10-26"
      )
    ).toBe("2034-07-01")
    // a dead rule (exhausted COUNT) still scans the whole ladder → null
    expect(
      nextOccurrenceDate(
        "2026-03-01",
        "FREQ=MONTHLY;COUNT=2;BYMONTHDAY=1",
        "2026-10-26"
      )
    ).toBeNull()
  })
  it("the closing rung finds live rules whose gap exceeds the early rungs", () => {
    // YEARLY;INTERVAL=100: ~100-year gaps — beyond the old ladder's
    // cumulative 34,000 days, the closing rung is what makes this non-null
    expect(
      nextOccurrenceDate(
        "2026-10-26",
        "FREQ=YEARLY;INTERVAL=100;BYMONTH=12;BYMONTHDAY=31",
        "2027-01-02"
      )
    ).toBe("2126-12-31")
    // widest gap a storable live rule can have: one Gregorian 400-year
    // cycle — leap-day yearly on a century-leap sequence (2000 → 2400)
    expect(
      nextOccurrenceDate(
        "2000-02-29",
        "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29",
        "2026-10-26"
      )
    ).toBe("2400-02-29")
    // and again past that occurrence (2001+100k ≡ 0 mod 100 → only
    // century-leap years match: 2400 → 2800)
    expect(
      nextOccurrenceDate(
        "2000-02-29",
        "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29",
        "2401-03-01"
      )
    ).toBe("2800-02-29")
  })
  it("resolves an expired UNTIL rule to null via the short-circuit", () => {
    // a plan live at write time (daily, dtstart years back) expires later —
    // every next-date read must answer null cheaply, not scan the ladder
    // while walking from dtstart
    expect(
      nextOccurrenceDate(
        "2020-01-01",
        "FREQ=DAILY;UNTIL=20210101T120000Z",
        "2026-10-26"
      )
    ).toBeNull()
  })
  it("clamps the ladder at the last storable ISO date (year-10000 truncation)", () => {
    // toISOString() switches to the extended six-digit form at year ≥ 10000
    // ("+010001-…"); the old slice(0,10) rung ends truncated into strings
    // whose parsed Date is invalid — rrule.between threw, every rung
    // answered "no occurrences", and a LIVE plan on a late-9999 dtstart
    // read as dead (and failed creation via the occurrence check)
    expect(nextOccurrenceDate("9999-06-15", "FREQ=DAILY", "9999-06-15")).toBe(
      "9999-06-15"
    )
    expect(nextOccurrenceDate("9999-12-31", "FREQ=DAILY", "2026-10-26")).toBe(
      "9999-12-31"
    )
    expect(
      nextOccurrenceDate(
        "9999-01-01",
        "FREQ=MONTHLY;BYMONTHDAY=15",
        "9999-06-16"
      )
    ).toBe("9999-07-15")
  })
  it("answers null when the only occurrences lie beyond the storable range", () => {
    // the real next occurrence (10000-06-14) cannot be handed back as a
    // 4-digit ISO date; the clamped rungs must stop widening instead of
    // re-scanning the identical window for the remaining rungs
    expect(
      nextOccurrenceDate(
        "9999-06-15",
        "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=14",
        "9999-06-15"
      )
    ).toBeNull()
  })
})

describe("isEmptyRule", () => {
  it("treats null/empty/whitespace as one-off markers", () => {
    expect(isEmptyRule(null)).toBe(true)
    expect(isEmptyRule("")).toBe(true)
    expect(isEmptyRule("   ")).toBe(true)
    expect(isEmptyRule("FREQ=MONTHLY")).toBe(false)
  })
})
