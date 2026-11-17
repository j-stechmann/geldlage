import { describe, it, expect } from "vitest"
import {
  parseOptionalAccountId,
  parseOptionalClampedInt,
  parsePagination,
  parseWindow,
  positiveInt,
  safePage,
} from "@/lib/api/query"

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

describe("safePage", () => {
  it("keeps valid pages and guards the OFFSET product", () => {
    expect(safePage("1", 25)).toBe(1)
    expect(safePage("4", 25)).toBe(4)
    expect(safePage("0", 25)).toBe(1)
    expect(safePage("abc", 25)).toBe(1)
    expect(safePage(String(Number.MAX_SAFE_INTEGER), 100)).toBe(1)
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

describe("parseOptionalAccountId", () => {
  it("accepts absent and positive digit strings", () => {
    expect(parseOptionalAccountId(null)).toEqual({ ok: true, value: undefined })
    expect(parseOptionalAccountId("12")).toEqual({ ok: true, value: 12 })
  })

  it("rejects anything parseInt would coerce", () => {
    for (const raw of ["", "0", "-1", "12.9", "12abc", " 12"]) {
      expect(parseOptionalAccountId(raw)).toEqual({ ok: false })
    }
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
  })
})

describe("parseWindow", () => {
  const today = "2026-11-17"
  const required = { fromDefault: "required" as const, toDefaultDays: null }
  const defaults = { fromDefault: "today" as const, toDefaultDays: 89 }

  it("requires from/to when no fallback is configured", () => {
    expect(parseWindow(sp(""), today, required)).toMatchObject({
      ok: false,
      error: "invalid_window",
    })
    expect(parseWindow(sp("from=2026-11-01"), today, required)).toMatchObject({
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
    const far = parseWindow(
      sp("from=2035-01-01&to=2035-01-02"),
      today,
      required
    )
    expect(far).toMatchObject({ ok: false, error: "window_too_far" })
  })

  it("rejects windows wider than the cap", () => {
    const wide = parseWindow(
      sp("from=2026-01-01&to=2027-06-01"),
      today,
      required
    )
    expect(wide).toMatchObject({ ok: false, error: "window_too_large" })
  })
})
