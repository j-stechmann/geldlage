import { describe, it, expect } from "vitest"
import {
  dayDiff,
  daysInMonth,
  isValidIsoDate,
  isoDateLocal,
  isoDatePlus,
  isoShift,
  lastDayOfMonthDay,
  lastDayOfMonthIso,
  MAX_ISO_DATE,
  MAX_MONTH_KEY,
  MIN_ISO_DATE,
  MIN_MONTH_KEY,
  monthCountBetween,
  monthOffset,
  monthSpanExceedsCap,
  monthsBetween,
  nextMonth,
  noonUtc,
  prevMonth,
  todayLocal,
} from "@/lib/dates"

describe("isValidIsoDate", () => {
  it("accepts real calendar days incl. leap years", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true)
    expect(isValidIsoDate("2025-02-28")).toBe(true)
    expect(isValidIsoDate("2026-12-31")).toBe(true)
  })

  it("rejects malformed and impossible dates", () => {
    expect(isValidIsoDate("2025-02-29")).toBe(false)
    expect(isValidIsoDate("2025-13-01")).toBe(false)
    expect(isValidIsoDate("2025-00-10")).toBe(false)
    expect(isValidIsoDate("2025-04-31")).toBe(false)
    expect(isValidIsoDate("2025-1-01")).toBe(false)
    expect(isValidIsoDate("")).toBe(false)
  })
})

describe("daysInMonth", () => {
  it("knows leap years", () => {
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2025, 2)).toBe(28)
    expect(daysInMonth(2025, 4)).toBe(30)
    expect(daysInMonth(2025, 12)).toBe(31)
  })

  it("keeps the real calendar for two-digit years", () => {
    // Date.UTC would map year 0 to 1900 (non-leap), but year 0 is a leap year
    expect(daysInMonth(0, 2)).toBe(29)
    expect(lastDayOfMonthIso("0000-02")).toBe("0000-02-29")
  })
})

describe("isoDatePlus", () => {
  it("crosses month, year and leap boundaries", () => {
    expect(isoDatePlus("2025-01-31", 1)).toBe("2025-02-01")
    expect(isoDatePlus("2025-12-31", 1)).toBe("2026-01-01")
    expect(isoDatePlus("2024-02-28", 1)).toBe("2024-02-29")
    expect(isoDatePlus("2025-03-01", -1)).toBe("2025-02-28")
  })

  it("keeps two-digit years in UTC arithmetic", () => {
    expect(isoDatePlus("0000-01-01", 0)).toBe("0000-01-01")
    expect(isoDatePlus("0000-02-28", 1)).toBe("0000-02-29") // year 0 is leap
    expect(isoDatePlus("0099-12-31", 1)).toBe("0100-01-01")
  })

  it("still overflows past the four-digit range for parseWindow to reject", () => {
    expect(isValidIsoDate(isoDatePlus(MAX_ISO_DATE, 1))).toBe(false)
  })
})

describe("noonUtc", () => {
  it("keeps two-digit years and anchors at noon UTC", () => {
    expect(noonUtc("0000-02-29").toISOString()).toBe("0000-02-29T12:00:00.000Z")
  })
})

describe("isoShift", () => {
  it("returns an empty string for malformed input", () => {
    expect(isoShift("not-a-date", 1)).toBe("")
    expect(isoShift("", -5)).toBe("")
  })

  it("shifts valid dates", () => {
    expect(isoShift("2025-01-31", 1)).toBe("2025-02-01")
    expect(isoShift("2025-01-01", -1)).toBe("2024-12-31")
  })
})

describe("dayDiff", () => {
  it("is absolute and rounded to whole days", () => {
    expect(dayDiff("2026-02-03", "2026-02-03")).toBe(0)
    expect(dayDiff("2026-02-01", "2026-02-08")).toBe(7)
    expect(dayDiff("2026-02-08", "2026-02-01")).toBe(7)
    expect(dayDiff("2026-01-31", "2026-02-01")).toBe(1)
  })

  it("returns NaN for malformed input", () => {
    expect(Number.isNaN(dayDiff("nope", "2026-02-01"))).toBe(true)
  })
})

describe("month helpers", () => {
  it("moves month keys across year boundaries", () => {
    expect(monthOffset("2025-12-15", 1)).toBe("2026-01")
    expect(monthOffset("2025-01-15", -1)).toBe("2024-12")
    expect(monthOffset("2025-06-15", 0)).toBe("2025-06")
    expect(prevMonth("2025-01")).toBe("2024-12")
    expect(nextMonth("2025-12")).toBe("2026-01")
    expect(prevMonth("2025-07")).toBe("2025-06")
    expect(nextMonth("2025-06")).toBe("2025-07")
  })

  it("moves across the representable month-key boundaries", () => {
    // The representable keys are 0000-01 … 9999-12; offsets that would leave
    // that range must fail loudly instead of emitting a corrupt key.
    expect(MIN_MONTH_KEY).toBe("0000-01")
    expect(MAX_MONTH_KEY).toBe("9999-12")
    expect(prevMonth("0001-01")).toBe("0000-12")
    expect(nextMonth("9998-12")).toBe("9999-01")
    expect(prevMonth("0000-06")).toBe("0000-05")
    expect(() => prevMonth("0000-01")).toThrow(RangeError)
    expect(() => nextMonth("9999-12")).toThrow(RangeError)
  })

  it("rejects malformed month keys instead of looping or emitting garbage", () => {
    // an empty key used to parse as year 0 / month NaN, so monthsBetween's
    // loop condition never advanced — it hung instead of returning.
    for (const bad of [
      "",
      "nope",
      "0000",
      "2026-13",
      "2026-00",
      // a valid prefix with trailing garbage must not be read as that month
      "2026-01x",
      "2026-01 ",
      "2026-01-01T00:00:00Z",
    ]) {
      expect(() => monthOffset(bad, 0)).toThrow(RangeError)
      expect(() => monthCountBetween(bad, "2026-01")).toThrow(RangeError)
      expect(() => monthsBetween(bad, "2026-01")).toThrow(RangeError)
      expect(() => lastDayOfMonthIso(bad)).toThrow(RangeError)
    }
    expect(() => monthsBetween("2026-01", "nope")).toThrow(RangeError)
    expect(() => monthOffset("2026-01", Number.NaN)).toThrow(RangeError)
    expect(() => monthOffset("2026-01", 1.5)).toThrow(RangeError)
  })

  it("lists inclusive month keys between dates", () => {
    expect(monthsBetween("2025-11-20", "2026-02-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ])
  })

  it("counts inclusive months without materializing them", () => {
    expect(monthCountBetween("2025-11-20", "2026-02-02")).toBe(4)
    expect(monthCountBetween("2026-01-15", "2026-01-20")).toBe(1)
    expect(monthCountBetween("2025-02", "2025-02")).toBe(1)
    expect(monthCountBetween("2026-02", "2026-01")).toBe(0)
    expect(monthCountBetween("2027-01", "2026-01")).toBe(-11)
  })

  it("caps the inclusive month span at 1200 months", () => {
    expect(monthSpanExceedsCap("1926-01-01", "2025-12-31")).toBe(false)
    expect(monthSpanExceedsCap("1925-12-01", "2025-12-31")).toBe(true)
    expect(monthSpanExceedsCap("0000-01-01", "9999-12-31")).toBe(true)
  })

  it("returns the last day in both forms", () => {
    expect(lastDayOfMonthIso("2025-02")).toBe("2025-02-28")
    expect(lastDayOfMonthIso("2024-02")).toBe("2024-02-29")
    expect(lastDayOfMonthIso("2025-04")).toBe("2025-04-30")
    expect(lastDayOfMonthIso("2025-12")).toBe("2025-12-31")
    expect(lastDayOfMonthDay("2025-02-10")).toBe("28")
    expect(lastDayOfMonthDay("2024-02-10")).toBe("29")
    expect(lastDayOfMonthDay("2025-04-01")).toBe("30")
    expect(lastDayOfMonthDay("2025-12-01")).toBe("31")
  })
})

describe("local calendar helpers", () => {
  it("formats the local calendar day, not the UTC day", () => {
    // 00:30 in the pinned Europe/Berlin zone is 23:30 UTC on the previous
    // day, so a toISOString()-based implementation returns 2025-01-01
    const d = new Date(2025, 0, 2, 0, 30)
    expect(d.toISOString().slice(0, 10)).toBe("2025-01-01")
    expect(isoDateLocal(d)).toBe("2025-01-02")
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe("representable ISO range", () => {
  it("is the four-digit ISO range and derives the month keys", () => {
    expect(MIN_ISO_DATE).toBe("0000-01-01")
    expect(MAX_ISO_DATE).toBe("9999-12-31")
    expect(MIN_MONTH_KEY).toBe("0000-01")
    expect(MAX_MONTH_KEY).toBe("9999-12")
  })
})
