import { describe, it, expect } from "vitest"
import {
  expandOccurrenceDates,
  isValidIsoDate,
  isoDatePlus,
  isEmptyRule,
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

  it("honours COUNT", () => {
    const dates = expandOccurrenceDates("2026-06-01", "FREQ=MONTHLY;COUNT=2", {
      from: "2026-01-01",
      to: "2030-01-01",
    })
    expect(dates).toEqual(["2026-06-01", "2026-07-01"])
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
})

describe("isEmptyRule", () => {
  it("treats null/empty/whitespace as one-off markers", () => {
    expect(isEmptyRule(null)).toBe(true)
    expect(isEmptyRule("")).toBe(true)
    expect(isEmptyRule("   ")).toBe(true)
    expect(isEmptyRule("FREQ=MONTHLY")).toBe(false)
  })
})
