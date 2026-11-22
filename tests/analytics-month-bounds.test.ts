import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import { accounts, transactions } from "@/lib/db/schema"
import { computeAnalytics } from "@/lib/analytics/engine"
import { parseFilters } from "@/lib/analytics/queries"
import { setupTestDb } from "./helpers"

const TODAY = "2026-11-17"

let db: Db
let userId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  const accountId = db
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
    db.insert(transactions)
      .values({
        id,
        userId,
        accountId,
        bookingDate,
        status: "Gebucht",
        type: "Eingang",
        amountCents: 100,
        sourceHash: `h-${id}`,
      })
      .run()
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
