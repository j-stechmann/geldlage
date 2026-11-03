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

  it("rejects an explicit TZID part (the parser would silently strip it)", () => {
    // rrule's string parser never carries TZID into origOptions, so the
    // part-based unsupported check cannot see it — without the textual
    // guard "TZID=Europe/Berlin;FREQ=…" would be stored as if the user had
    // never written the part (canonicalization must reject, not strip)
    expectRuleError(
      "TZID=Europe/Berlin;FREQ=MONTHLY;BYMONTHDAY=1",
      "unsupported part: TZID"
    )
    expectRuleError("FREQ=MONTHLY;BYMONTHDAY=1;TZID=Europe/Berlin")
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

  it("monthly day-31 rules clamp to the month's last day", () => {
    const dates = expandOccurrenceDates(
      "2026-01-31",
      "FREQ=MONTHLY;BYMONTHDAY=31",
      { from: "2026-01-01", to: "2026-04-30" }
    )
    // January has 31, February clamps to 28, March has 31, April to 30
    expect(dates).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ])
  })

  it("day-29 rules keep Feb 29 in leap years and clamp to Feb 28 otherwise", () => {
    const dates = expandOccurrenceDates(
      "2024-01-29",
      "FREQ=MONTHLY;BYMONTHDAY=29",
      { from: "2024-01-01", to: "2025-03-31" }
    )
    expect(dates).toEqual([
      "2024-01-29",
      "2024-02-29",
      "2024-03-29",
      "2024-04-29",
      "2024-05-29",
      "2024-06-29",
      "2024-07-29",
      "2024-08-29",
      "2024-09-29",
      "2024-10-29",
      "2024-11-29",
      "2024-12-29",
      "2025-01-29",
      "2025-02-28",
      "2025-03-29",
    ])
  })

  it("day-of-month anchors before DTSTART are skipped, later ones in the same month stay", () => {
    // the rule day already passed in the DTSTART month → next month is first
    expect(
      expandOccurrenceDates("2026-01-31", "FREQ=MONTHLY;BYMONTHDAY=1", {
        from: "2026-01-01",
        to: "2026-02-28",
      })
    ).toEqual(["2026-02-01"])
    // DTSTART mid-month: the clamped month end after it is still the first
    expect(
      expandOccurrenceDates("2026-01-15", "FREQ=MONTHLY;BYMONTHDAY=31", {
        from: "2026-01-01",
        to: "2026-02-28",
      })
    ).toEqual(["2026-01-31", "2026-02-28"])
    // that DTSTART-month clamp also consumes COUNT (rrule would have skipped
    // February entirely)
    expect(
      expandOccurrenceDates(
        "2026-02-15",
        "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=1",
        {
          from: "2026-01-01",
          to: "2026-12-31",
        }
      )
    ).toEqual(["2026-02-28"])
    // DTSTART after the clamped day of its own month: January's 30th already
    // passed on Jan 31, so February's month end is the first occurrence
    expect(
      expandOccurrenceDates("2026-01-31", "FREQ=MONTHLY;BYMONTHDAY=30", {
        from: "2026-01-01",
        to: "2026-03-31",
      })
    ).toEqual(["2026-02-28", "2026-03-30"])
  })

  it("several clamped days in one month collapse to a single month end", () => {
    const dates = expandOccurrenceDates(
      "2026-01-31",
      "FREQ=MONTHLY;BYMONTHDAY=30,31",
      { from: "2026-02-01", to: "2026-02-28" }
    )
    expect(dates).toEqual(["2026-02-28"])
    // the collapsed date also counts once: with COUNT=3 the sequence is
    // Feb 28 → Mar 30 → Mar 31, not Feb 28 twice and then Mar 30
    expect(
      expandOccurrenceDates(
        "2026-02-01",
        "FREQ=MONTHLY;BYMONTHDAY=30,31;COUNT=3",
        { from: "2026-02-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-02-28", "2026-03-30", "2026-03-31"])
  })

  it("keeps both dates when only one of several day anchors clamps", () => {
    // ascending day order within a month, and a non-clamping day alongside a
    // clamping one (1 always exists, 31 becomes the month end)
    expect(
      expandOccurrenceDates("2026-01-01", "FREQ=MONTHLY;BYMONTHDAY=1,31", {
        from: "2026-01-01",
        to: "2026-02-28",
      })
    ).toEqual(["2026-01-01", "2026-01-31", "2026-02-01", "2026-02-28"])
  })

  it("resolves negative anchors alongside a clamping day", () => {
    // both 31 and -1 resolve to the month end → one date
    expect(
      expandOccurrenceDates("2026-01-01", "FREQ=MONTHLY;BYMONTHDAY=31,-1", {
        from: "2026-02-01",
        to: "2026-02-28",
      })
    ).toEqual(["2026-02-28"])
    expect(
      expandOccurrenceDates("2026-01-01", "FREQ=MONTHLY;BYMONTHDAY=31,-1", {
        from: "2026-01-01",
        to: "2026-01-31",
      })
    ).toEqual(["2026-01-31"])
  })

  it("negative-only anchors keep RRULE semantics (no clamping)", () => {
    // -31 is the 1st in 31-day months and does not exist in February —
    // only positive 29–31 anchors clamp to month end
    expect(
      expandOccurrenceDates("2026-01-01", "FREQ=MONTHLY;BYMONTHDAY=-31", {
        from: "2026-01-01",
        to: "2026-03-31",
      })
    ).toEqual(["2026-01-01", "2026-03-01"])
    // mixed: -15 resolves to a different day than the clamped 31
    expect(
      expandOccurrenceDates("2026-01-01", "FREQ=MONTHLY;BYMONTHDAY=31,-15", {
        from: "2026-02-01",
        to: "2026-02-28",
      })
    ).toEqual(["2026-02-14", "2026-02-28"])
  })

  it("does not take the clamp path for rules with non-allowlisted date parts", () => {
    // corrupt/legacy rows can carry parts validateRrule rejects; clamping
    // them would invent dates rrule never yields
    for (const rule of [
      "FREQ=MONTHLY;BYYEARDAY=100;BYMONTHDAY=31",
      "FREQ=YEARLY;BYWEEKNO=20;BYMONTHDAY=31",
      "FREQ=MONTHLY;BYEASTER=0;BYMONTHDAY=31",
      "FREQ=YEARLY;BYEASTER=0;BYMONTHDAY=29",
    ]) {
      expect(
        expandOccurrenceDates("2026-01-01", rule, {
          from: "2026-01-01",
          to: "2026-12-31",
        }),
        rule
      ).toEqual([])
    }
    // BYHOUR is time-of-day intent, not a plain day-of-month rule — the
    // clamp must not add February to the months rrule skips
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=MONTHLY;BYHOUR=12;BYMONTHDAY=31",
        { from: "2026-01-01", to: "2026-12-31" }
      )
    ).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-08-31",
      "2026-10-31",
      "2026-12-31",
    ])
  })

  it("does not resurrect a rule with an invalid BYMONTH via the clamp path", () => {
    // rrule treats BYMONTH outside 1–12 (or fractional) as dead; the clamp
    // path must fall through to rrule instead of inventing a live February
    for (const rule of [
      "FREQ=YEARLY;BYMONTH=0,2;BYMONTHDAY=31",
      "FREQ=YEARLY;BYMONTH=2,13;BYMONTHDAY=31",
      "FREQ=YEARLY;BYMONTH=2.5,2;BYMONTHDAY=31",
    ]) {
      expect(
        expandOccurrenceDates("2026-01-01", rule, {
          from: "2026-01-01",
          to: "2026-12-31",
        }),
        rule
      ).toEqual([])
      expect(
        nextOccurrenceDate("2026-01-01", rule, "2026-01-01"),
        rule
      ).toBeNull()
    }
  })

  it("month-end clamping keeps the INTERVAL month phase", () => {
    const dates = expandOccurrenceDates(
      "2026-01-31",
      "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31",
      { from: "2026-01-01", to: "2026-12-31" }
    )
    // Jan/Mar/May/Jul/Sep/Nov only; September and November clamp to 30
    expect(dates).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-09-30",
      "2026-11-30",
    ])
  })

  it("month-end clamping respects BYMONTH filters", () => {
    const dates = expandOccurrenceDates(
      "2026-01-01",
      "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31",
      { from: "2026-01-01", to: "2026-12-31" }
    )
    expect(dates).toEqual(["2026-02-28"])
  })

  it("COUNT counts clamped occurrences (not the months rrule would skip)", () => {
    const dates = expandOccurrenceDates(
      "2026-01-31",
      "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
      { from: "2026-01-01", to: "2026-12-31" }
    )
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"])
    // BYMONTH also bounds the counted set (MONTHLY;BYMONTH=2 = yearly Feb)
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31;COUNT=2",
        { from: "2026-01-01", to: "2027-12-31" }
      )
    ).toEqual(["2026-02-28", "2027-02-28"])
  })

  it("COUNT keeps counting occurrences before the window starts", () => {
    // Jan 31 and Feb 28 are consumed before the window; only the 3rd remains
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
        { from: "2026-03-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-03-31"])
    // with COUNT=4 the 4th clamped date (April 30) is still inside
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4",
        { from: "2026-03-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-03-31", "2026-04-30"])
    expect(
      nextOccurrenceDate(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
        "2026-04-01"
      )
    ).toBeNull()
  })

  it("applies the occurrence cap to the clamp path", () => {
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31",
        { from: "2026-01-01", to: "2026-12-31" },
        2
      )
    ).toEqual(["2026-01-31", "2026-02-28"])
    // cap 0 means "none", matching the rrule path's slice(0, cap)
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31",
        { from: "2026-01-01", to: "2026-12-31" },
        0
      )
    ).toEqual([])
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=1",
        { from: "2026-01-01", to: "2026-12-31" },
        0
      )
    ).toEqual([])
  })

  it("degrades corrupt INTERVAL/COUNT rows to no occurrences", () => {
    // validateRrule rejects these; a defence-in-depth row must not become a
    // live rule (or hang rrule's iterator) because it took another path
    for (const rule of [
      "FREQ=MONTHLY;INTERVAL=0;BYMONTHDAY=31",
      "FREQ=MONTHLY;INTERVAL=-1;BYMONTHDAY=31",
      "FREQ=MONTHLY;INTERVAL=1.5;BYMONTHDAY=31",
      "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=0",
      "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=-1",
      "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=1.5",
    ]) {
      expect(
        expandOccurrenceDates("2026-01-31", rule, {
          from: "2026-01-01",
          to: "2026-12-31",
        }),
        rule
      ).toEqual([])
    }
    // non-clamp shapes take the same central guard
    expect(
      expandOccurrenceDates("2026-01-31", "FREQ=DAILY;INTERVAL=-1", {
        from: "2026-01-01",
        to: "2026-12-31",
      })
    ).toEqual([])
  })

  it("UNTIL includes a clamped month end on or before its day", () => {
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20260228T120000Z",
        { from: "2026-01-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-01-31", "2026-02-28"])
    // sub-noon UNTIL is lifted to noon (normalizeRuleInput), keeping the
    // clamped month end on that day
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20260228T115959Z",
        { from: "2026-01-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-01-31", "2026-02-28"])
    // date-only UNTIL takes the same lift, so its day stays included
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20260228",
        { from: "2026-01-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-01-31", "2026-02-28"])
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20260227T120000Z",
        { from: "2026-01-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-01-31"])
  })

  it("nextOccurrenceDate returns a clamped month end", () => {
    expect(
      nextOccurrenceDate(
        "2026-01-31",
        "FREQ=MONTHLY;BYMONTHDAY=31",
        "2026-02-01"
      )
    ).toBe("2026-02-28")
    expect(
      nextOccurrenceDate(
        "2024-02-29",
        "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
        "2025-01-01"
      )
    ).toBe("2025-02-28")
  })

  it("yearly leap-day rules clamp to Feb 28 in non-leap years", () => {
    const dates = expandOccurrenceDates(
      "2024-02-29",
      "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
      { from: "2024-01-01", to: "2027-12-31" }
    )
    expect(dates).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
    ])
  })

  it("yearless yearly BYMONTHDAY repeats every month with clamping", () => {
    const dates = expandOccurrenceDates(
      "2026-01-31",
      "FREQ=YEARLY;BYMONTHDAY=31",
      { from: "2026-01-01", to: "2026-12-31" }
    )
    expect(dates).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
    ])
  })

  it("yearly multiple months stay chronological even when BYMONTH is unsorted", () => {
    const dates = expandOccurrenceDates(
      "2026-01-01",
      "FREQ=YEARLY;BYMONTH=4,2;BYMONTHDAY=31",
      { from: "2026-01-01", to: "2026-12-31" }
    )
    expect(dates).toEqual(["2026-02-28", "2026-04-30"])
  })

  it("yearly February day-30 rules clamp like day-31", () => {
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
        { from: "2026-01-01", to: "2028-12-31" }
      )
    ).toEqual(["2026-02-28", "2027-02-28", "2028-02-29"])
  })

  it("deduplicates repeated BYMONTH values", () => {
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=YEARLY;BYMONTH=2,2;BYMONTHDAY=31",
        { from: "2026-01-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-02-28"])
  })

  it("yearly INTERVAL and COUNT work on clamped occurrences", () => {
    expect(
      expandOccurrenceDates(
        "2024-02-29",
        "FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29",
        { from: "2024-01-01", to: "2028-12-31" }
      )
    ).toEqual(["2024-02-29", "2026-02-28", "2028-02-29"])
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31;COUNT=3",
        { from: "2026-01-01", to: "2030-12-31" }
      )
    ).toEqual(["2026-02-28", "2027-02-28", "2028-02-29"])
  })

  it("yearly UNTIL includes a clamped month end", () => {
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;UNTIL=20260228T120000Z",
        { from: "2026-01-01", to: "2030-12-31" }
      )
    ).toEqual(["2026-02-28"])
  })

  it("yearless yearly COUNT/UNTIL bound the clamped month ends", () => {
    expect(
      expandOccurrenceDates("2026-01-01", "FREQ=YEARLY;BYMONTHDAY=31;COUNT=2", {
        from: "2026-01-01",
        to: "2026-12-31",
      })
    ).toEqual(["2026-01-31", "2026-02-28"])
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=YEARLY;BYMONTHDAY=31;UNTIL=20260228T120000Z",
        { from: "2026-01-01", to: "2026-12-31" }
      )
    ).toEqual(["2026-01-31", "2026-02-28"])
  })

  it("raw DAILY/WEEKLY BYMONTHDAY filters keep RRULE's skip semantics", () => {
    // only MONTHLY/YEARLY day-of-month anchors clamp; a weekly filter on the
    // 31st still skips February and April
    expect(
      expandOccurrenceDates("2026-01-01", "FREQ=WEEKLY;BYMONTHDAY=31", {
        from: "2026-01-01",
        to: "2026-04-30",
      })
    ).toEqual(["2026-01-31", "2026-03-31"])
  })

  it("BYDAY/BYSETPOS day-of-month intersections keep RRULE semantics", () => {
    // BYDAY intersects the expanded day set; a missing 31st is a filter
    // result, not a due date that moved to month end
    expect(
      expandOccurrenceDates(
        "2026-01-31",
        "FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=31",
        { from: "2026-02-01", to: "2026-02-28" }
      )
    ).toEqual([])
    // July 31 2026 is a Friday → the intersection still fires
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=31",
        { from: "2026-07-01", to: "2026-07-31" }
      )
    ).toEqual(["2026-07-31"])
    // April has no 31st at all: the BYMONTHDAY filter yields nothing and
    // BYSETPOS must not invent a clamped month end
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=MONTHLY;BYDAY=TH;BYMONTHDAY=31",
        { from: "2026-04-01", to: "2026-04-30" }
      )
    ).toEqual([])
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=MONTHLY;BYMONTHDAY=29,30,31;BYSETPOS=-1",
        { from: "2026-02-01", to: "2026-02-28" }
      )
    ).toEqual([])
    expect(
      expandOccurrenceDates(
        "2026-01-01",
        "FREQ=MONTHLY;BYMONTHDAY=29,30,31;BYSETPOS=-1",
        { from: "2026-01-01", to: "2026-01-31" }
      )
    ).toEqual(["2026-01-31"])
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
    // the same cadence on a clampable day is no longer sparse: clamping fires
    // in 2100/2200/2300 too (Feb 28), so the closing rung still finds the
    // first one after the window
    expect(
      nextOccurrenceDate(
        "2000-03-01",
        "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29",
        "2026-10-26"
      )
    ).toBe("2100-02-28")
    expect(
      nextOccurrenceDate(
        "2000-03-01",
        "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29",
        "2101-01-01"
      )
    ).toBe("2200-02-28")
    // widest gap the ladder is sized for: a century-cadence weekday
    // intersection spans one Gregorian 400-year cycle — a Feb-29-that-is-a-
    // Tuesday rule keeps the day anchor out of the clamp path
    // (BYDAY+BYMONTHDAY), so only the century-leap sequence matches
    // (2000 → 2400)
    expect(
      nextOccurrenceDate(
        "2000-02-29",
        "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29;BYDAY=TU",
        "2026-10-26"
      )
    ).toBe("2400-02-29")
    // and again past that occurrence (2001+100k ≡ 0 mod 100 → only
    // century-leap years match: 2400 → 2800)
    expect(
      nextOccurrenceDate(
        "2000-02-29",
        "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29;BYDAY=TU",
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
