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
})

describe("isoDatePlus", () => {
  it("crosses month, year and leap boundaries", () => {
    expect(isoDatePlus("2025-01-31", 1)).toBe("2025-02-01")
    expect(isoDatePlus("2025-12-31", 1)).toBe("2026-01-01")
    expect(isoDatePlus("2024-02-28", 1)).toBe("2024-02-29")
    expect(isoDatePlus("2025-03-01", -1)).toBe("2025-02-28")
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
  it("format the local calendar day, not the UTC day", () => {
    const d = new Date(2025, 0, 2, 23, 30) // local Jan 2, 23:30
    expect(isoDateLocal(d)).toBe("2025-01-02")
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe("MAX_ISO_DATE", () => {
  it("is the top of the storable four-digit range", () => {
    expect(MAX_ISO_DATE).toBe("9999-12-31")
  })
})
