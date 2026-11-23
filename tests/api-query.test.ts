import { describe, it, expect } from "vitest"
import {
  INVALID_DATE_QUERIES,
  OVER_CAP_TWO_SIDED_QUERIES,
} from "./date-filter-cases"
import {
  parseAnalyticsDate,
  parseDateRange,
  parseOptionalAccountId,
  parseOptionalClampedInt,
  parsePage,
  parsePagination,
  parseWindow,
  positiveInt,
} from "@/lib/api/query"
import { MAX_DATE_RANGE_MONTHS } from "@/lib/dates"

function sp(query: string): URLSearchParams {
  return new URLSearchParams(query)
}

describe("positiveInt", () => {
  it("is parseInt-permissive and falls back on non-positive input", () => {
    expect(positiveInt("3", 20)).toBe(3)
    expect(positiveInt("3abc", 20)).toBe(3)
    expect(positiveInt("0", 20)).toBe(20)
    expect(positiveInt("-2", 20)).toBe(20)
    expect(positiveInt(null, 20)).toBe(20)
  })
})

describe("parsePage", () => {
  it("falls back to page 1 for missing, non-positive or overflowing input", () => {
    expect(parsePage("0")).toBe(1)
    expect(parsePage("-3")).toBe(1)
    expect(parsePage("abc")).toBe(1)
    expect(parsePage(null)).toBe(1)
    // parseInt stops at "e", so exponential notation is page 1 — not 1e18
    expect(parsePage("1e18")).toBe(1)
    expect(parsePage("9".repeat(400))).toBe(1) // Infinity
  })

  it("echoes valid pages, including values above 2^53", () => {
    expect(parsePage("1")).toBe(1)
    expect(parsePage("4")).toBe(4)
    expect(parsePage(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER
    )
    expect(parsePage(String(1e18))).toBe(1e18)
  })
})

describe("parsePagination", () => {
  it("uses the per-route defaults and clamps the size", () => {
    expect(
      parsePagination(sp(""), { defaultPageSize: 25, maxPageSize: 100 })
    ).toEqual({ page: 1, pageSize: 25, paginated: true })
    expect(
      parsePagination(sp("page=2&pageSize=500"), {
        defaultPageSize: 20,
        maxPageSize: 100,
      })
    ).toEqual({ page: 2, pageSize: 100, paginated: true })
  })

  it("only paginates when asked (plans' legacy full-list contract)", () => {
    expect(
      parsePagination(sp(""), {
        defaultPageSize: 20,
        maxPageSize: 100,
        onlyWhenPresent: true,
      }).paginated
    ).toBe(false)
    expect(
      parsePagination(sp("pageSize=10"), {
        defaultPageSize: 20,
        maxPageSize: 100,
        onlyWhenPresent: true,
      }).paginated
    ).toBe(true)
  })
})

describe("parseAnalyticsDate", () => {
  it("accepts absent/empty and in-range ISO dates", () => {
    expect(parseAnalyticsDate(null)).toEqual({ ok: true, value: undefined })
    expect(parseAnalyticsDate("")).toEqual({ ok: true, value: undefined })
    expect(parseAnalyticsDate("2026-11-17")).toEqual({
      ok: true,
      value: "2026-11-17",
    })
    expect(parseAnalyticsDate("0000-01-01")).toEqual({
      ok: true,
      value: "0000-01-01",
    })
    expect(parseAnalyticsDate("9999-12-31")).toEqual({
      ok: true,
      value: "9999-12-31",
    })
  })

  it("rejects malformed and unrepresentable dates", () => {
    for (const raw of [
      "nope",
      "2026-02-29",
      "2026-13-01",
      "0000-00-10",
      "9999-13-01",
      "10000-01-01",
    ]) {
      expect(parseAnalyticsDate(raw)).toEqual({ ok: false })
    }
  })
})

describe("parseDateRange", () => {
  it("accepts absent, empty, and in-range date filters", () => {
    expect(parseDateRange(sp(""))).toEqual({ ok: true })
    expect(parseDateRange(sp("dateFrom=&dateTo="))).toEqual({
      ok: true,
    })
    expect(parseDateRange(sp("dateFrom=2026-01-01&dateTo=2026-12-31"))).toEqual(
      {
        ok: true,
        dateFrom: "2026-01-01",
        dateTo: "2026-12-31",
      }
    )
    expect(
      parseDateRange(sp("dateFrom=0000-01-01&dateTo=0000-12-31"))
    ).toMatchObject({ ok: true })
    expect(
      parseDateRange(sp("dateFrom=9999-01-01&dateTo=9999-12-31"))
    ).toMatchObject({ ok: true })
  })

  it("accepts an inverted range (empty result in both routes)", () => {
    expect(parseDateRange(sp("dateFrom=2026-12-31&dateTo=2026-01-01"))).toEqual(
      {
        ok: true,
        dateFrom: "2026-12-31",
        dateTo: "2026-01-01",
      }
    )
  })

  it("leaves the month cap opt-in (the transactions list is uncapped)", () => {
    // 1513 months: cheap as a SQL bound, so the shared parser accepts it
    expect(
      parseDateRange(sp("dateFrom=1900-01-01&dateTo=2026-01-01"))
    ).toMatchObject({ ok: true })
  })

  it("accepts exactly the month cap and rejects one month more when asked", () => {
    const capped = { maxMonths: MAX_DATE_RANGE_MONTHS }
    // (2025 - 1926) * 12 + 12 = 1200 inclusive months
    expect(
      parseDateRange(sp("dateFrom=1926-01-01&dateTo=2025-12-31"), capped)
    ).toMatchObject({ ok: true, dateFrom: "1926-01-01" })
    expect(
      parseDateRange(sp("dateFrom=1925-12-01&dateTo=2025-12-31"), capped)
    ).toMatchObject({ ok: false, error: "range_too_large" })
  })

  it("rejects full-calendar explicit ranges when the cap is enabled", () => {
    for (const query of OVER_CAP_TWO_SIDED_QUERIES) {
      expect(
        parseDateRange(sp(query), { maxMonths: MAX_DATE_RANGE_MONTHS })
      ).toMatchObject({
        ok: false,
        error: "range_too_large",
      })
    }
  })

  it("leaves one-sided ranges uncapped (the data side is unknown)", () => {
    // the engine degrades to populated months instead of rejecting these
    for (const query of ["dateFrom=0001-01-01", "dateTo=9999-12-31"]) {
      expect(parseDateRange(sp(query))).toMatchObject({ ok: true })
    }
    expect(parseDateRange(sp("dateFrom=2026-01-01"))).toEqual({
      ok: true,
      dateFrom: "2026-01-01",
      dateTo: undefined,
    })
  })

  it("rejects malformed or unrepresentable dates", () => {
    for (const query of INVALID_DATE_QUERIES) {
      expect(parseDateRange(sp(query))).toMatchObject({
        ok: false,
        error: "invalid_date",
      })
    }
  })
})

describe("parseOptionalAccountId", () => {
  it("accepts absent and positive digit strings", () => {
    expect(parseOptionalAccountId(null)).toEqual({ ok: true, value: undefined })
    expect(parseOptionalAccountId("12")).toEqual({ ok: true, value: 12 })
  })

  it("rejects anything parseInt would coerce", () => {
    for (const raw of ["", "0", "-1", "12.9", "12abc", " 12"]) {
      expect(parseOptionalAccountId(raw)).toEqual({ ok: false })
    }
    // a 400-digit value parses to Infinity, which is not an account id
    expect(parseOptionalAccountId("9".repeat(400))).toEqual({ ok: false })
  })
})

describe("parseOptionalClampedInt", () => {
  it("falls back when absent and clamps digits", () => {
    const opts = { min: 1, max: 60, fallback: 12 }
    expect(parseOptionalClampedInt(null, opts)).toEqual({ ok: true, value: 12 })
    expect(parseOptionalClampedInt("0", opts)).toEqual({ ok: true, value: 1 })
    expect(parseOptionalClampedInt("999", opts)).toEqual({
      ok: true,
      value: 60,
    })
    expect(parseOptionalClampedInt("12abc", opts)).toEqual({ ok: false })
    // Infinity (overflowing digits) still clamps to the ceiling, like any
    // other out-of-range numeric value
    expect(parseOptionalClampedInt("9".repeat(400), opts)).toEqual({
      ok: true,
      value: 60,
    })
  })
})

describe("parseWindow", () => {
  const today = "2026-11-17"
  const defaults = { defaultToDays: 89 }

  it("requires from/to when no fallback is configured", () => {
    expect(parseWindow(sp(""), today)).toMatchObject({
      ok: false,
      error: "invalid_window",
    })
    expect(parseWindow(sp("from=2026-11-01"), today)).toMatchObject({
      ok: false,
      error: "invalid_window",
    })
  })

  it("defaults from/to on the occurrences contract", () => {
    expect(parseWindow(sp(""), today, defaults)).toEqual({
      ok: true,
      from: today,
      to: "2027-02-14",
    })
  })

  it("validates ISO dates and ordering", () => {
    expect(
      parseWindow(sp("from=nope&to=2026-11-20"), today, defaults)
    ).toMatchObject({ ok: false, error: "invalid_window" })
    expect(
      parseWindow(sp("from=2026-11-20&to=2026-11-01"), today, defaults)
    ).toMatchObject({ ok: false, error: "invalid_window" })
  })

  it("rejects far windows before the width cap", () => {
    const far = parseWindow(sp("from=2035-01-01&to=2035-01-02"), today)
    expect(far).toMatchObject({ ok: false, error: "window_too_far" })

    // far and wide: only the distance-first order yields window_too_far
    const farAndWide = parseWindow(sp("from=2035-01-01&to=2036-06-01"), today)
    expect(farAndWide).toMatchObject({ ok: false, error: "window_too_far" })

    // the width check's isoDatePlus would overflow past year 9999; the
    // distance check must catch this window first
    const nearMax = parseWindow(sp("from=9999-01-01&to=9999-12-31"), today)
    expect(nearMax).toMatchObject({ ok: false, error: "window_too_far" })

    // the from-side distance check runs before `to` is derived or validated,
    // so this near-MAX_ISO_DATE `from` reports window_too_far instead of an
    // invalid_window from the overflowing default `to`
    const nearMaxDefault = parseWindow(sp("from=9999-12-31"), today, defaults)
    expect(nearMaxDefault).toMatchObject({
      ok: false,
      error: "window_too_far",
    })

    // ... and the from-side check wins over a malformed, missing, or
    // inverted `to`
    expect(
      parseWindow(sp("from=2035-01-01&to=nope"), today, defaults)
    ).toMatchObject({ ok: false, error: "window_too_far" })
    expect(parseWindow(sp("from=1900-01-01"), today)).toMatchObject({
      ok: false,
      error: "window_too_far",
    })
    expect(
      parseWindow(sp("from=2035-01-01&to=2026-01-01"), today)
    ).toMatchObject({ ok: false, error: "window_too_far" })
  })

  it("rejects windows wider than the cap", () => {
    const wide = parseWindow(sp("from=2026-01-01&to=2027-06-01"), today)
    expect(wide).toMatchObject({ ok: false, error: "window_too_large" })
  })
})
