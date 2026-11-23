import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import { accounts } from "@/lib/db/schema"
import { computeAnalytics } from "@/lib/analytics/engine"
import { parseFilters } from "@/lib/analytics/queries"
import { seedBookedTransaction, setupTestDb } from "./helpers"

const TODAY = "2026-11-17"

let db: Db
let userId: number
let accountId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  accountId = db
    .insert(accounts)
    .values({ userId, iban: "DE02120300000000202051", name: "Girokonto" })
    .returning()
    .get().id
  for (const [id, bookingDate] of [
    ["tx-min", "0000-01-10"],
    ["tx-min-neighbor", "0001-01-10"],
    ["tx-max-neighbor", "9998-12-20"],
    ["tx-max", "9999-12-20"],
  ] as const) {
    seedBookedTransaction(db, userId, id, bookingDate, { accountId })
  }
})

function filters(query: string) {
  return parseFilters(new URLSearchParams(query))
}

describe("analytics month-key bounds", () => {
  it("does not derive a month before 0000-01 for a partial dateTo", () => {
    const r = computeAnalytics(filters("dateTo=0000-01-15"), userId, TODAY)
    expect(r.monthlyCashflow.map((p) => p.month)).toEqual(["0000-01"])
    expect(r.kpis.monthsCounted).toBe(0)
    expect(r.kpis.avgMonthlyIncomeCents).toBeNull()
  })

  it("does not derive a month after 9999-12 for a partial dateFrom", () => {
    const r = computeAnalytics(filters("dateFrom=9999-12-15"), userId, TODAY)
    expect(r.monthlyCashflow.map((p) => p.month)).toEqual(["9999-12"])
    expect(r.kpis.monthsCounted).toBe(0)
    expect(r.kpis.avgMonthlyIncomeCents).toBeNull()
  })

  it("excludes a partial dateTo in 0001-01 through the route-valid boundary", () => {
    const r = computeAnalytics(
      filters("dateFrom=0001-01-01&dateTo=0001-01-15"),
      userId,
      TODAY
    )
    expect(r.monthlyCashflow.map((p) => p.month)).toEqual(["0001-01"])
    expect(r.kpis.monthsCounted).toBe(0)
    expect(r.kpis.avgMonthlyIncomeCents).toBeNull()
  })

  it("excludes a partial dateFrom in 9998-12 through the route-valid boundary", () => {
    const r = computeAnalytics(
      filters("dateFrom=9998-12-15&dateTo=9998-12-31"),
      userId,
      TODAY
    )
    expect(r.monthlyCashflow.map((p) => p.month)).toEqual(["9998-12"])
    expect(r.kpis.monthsCounted).toBe(0)
    expect(r.kpis.avgMonthlyIncomeCents).toBeNull()
  })
})

describe("analytics month-span cap", () => {
  it("degrades to populated months when a data-derived span exceeds the cap", () => {
    // seeded rows span 0000-01 … 9999-12; no synthetic months between them
    const populated = ["0000-01", "0001-01", "9998-12", "9999-12"]

    expect(
      computeAnalytics(filters(""), userId, TODAY).monthlyCashflow.map(
        (p) => p.month
      )
    ).toEqual(populated)
    // a one-sided dateTo leaves the start at the data minimum
    expect(
      computeAnalytics(
        filters("dateTo=9999-12-31"),
        userId,
        TODAY
      ).monthlyCashflow.map((p) => p.month)
    ).toEqual(populated)
  })

  it("averages over the populated full months when the series degrades", () => {
    // the synthetic century-wide span is never materialized, so it must not
    // dilute the "over N full months" KPI; only the populated months that
    // are full and not in the future count (0000-01 and 0001-01 here)
    const r = computeAnalytics(filters(""), userId, TODAY)
    expect(r.kpis.monthsCounted).toBe(2)
    expect(r.kpis.avgMonthlyIncomeCents).toBe(100)
    expect(r.kpis.avgMonthlyExpensesCents).toBe(0)
  })

  it("materializes exactly 1200 months at the cap", () => {
    seedBookedTransaction(db, userId, "tx-mid", "1950-06-15", { accountId })

    const r = computeAnalytics(
      filters("dateFrom=1926-01-01&dateTo=2025-12-31"),
      userId,
      TODAY
    )
    expect(r.monthlyCashflow).toHaveLength(1200)
    expect(r.monthlyCashflow[0].month).toBe("1926-01")
    expect(r.monthlyCashflow.at(-1)?.month).toBe("2025-12")
  })

  it("degrades one month past the cap instead of zero-filling", () => {
    seedBookedTransaction(db, userId, "tx-mid", "1950-06-15", { accountId })

    const r = computeAnalytics(
      filters("dateFrom=1925-12-01&dateTo=2025-12-31"),
      userId,
      TODAY
    )
    expect(r.monthlyCashflow.map((p) => p.month)).toEqual(["1950-06"])
  })

  it("ignores unrepresentable booking dates instead of crashing", () => {
    // the column has no format CHECK; legacy/direct-DB rows can be empty
    seedBookedTransaction(db, userId, "tx-empty", "", { accountId })

    const r = computeAnalytics(filters(""), userId, TODAY)
    expect(r.monthlyCashflow.map((p) => p.month)).toEqual([
      "0000-01",
      "0001-01",
      "9998-12",
      "9999-12",
    ])
  })

  it("drops malformed direct-caller dates instead of throwing in month math", () => {
    // parseFilters is the direct-caller entry point (engine tests, query
    // helpers); its date validation must match the route's, so a malformed
    // value never reaches monthOf/monthSpanExceedsCap (RangeError). The call
    // itself would throw if the invalid filter leaked through.
    const r = computeAnalytics(filters("dateTo=nope"), userId, TODAY)
    expect(r.monthlyCashflow.map((p) => p.month)).toEqual([
      "0000-01",
      "0001-01",
      "9998-12",
      "9999-12",
    ])
  })
})
