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
  monthOffset,
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
    // 0001-01 and 9998-12 are the outermost months whose neighbour is still
    // representable; the analytics route rejects anything beyond them.
    expect(prevMonth("0001-01")).toBe("0000-12")
    expect(nextMonth("9998-12")).toBe("9999-01")
    expect(prevMonth("0000-06")).toBe("0000-05")
  })

  it("lists inclusive month keys between dates", () => {
    expect(monthsBetween("2025-11-20", "2026-02-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ])
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

describe("MAX_ISO_DATE", () => {
  it("is the top of the storable four-digit range", () => {
    expect(MAX_ISO_DATE).toBe("9999-12-31")
  })
})
