import { describe, it, expect, beforeEach } from "vitest"
import { GET as getAnalytics } from "@/app/api/analytics/route"
import { GET as getTransactions } from "@/app/api/transactions/route"
import type { Db } from "@/lib/db"
import { authedRequest, seedBookedTransaction, setupTestDb } from "./helpers"
import {
  INVALID_DATE_QUERIES,
  OVER_CAP_TWO_SIDED_QUERIES,
} from "./date-filter-cases"

const BASE = "http://localhost:3000"

let db: Db
let userId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
})

async function requestBoth(query: string) {
  return Promise.all([
    authedRequest(`${BASE}/api/analytics?${query}`, userId).then(getAnalytics),
    authedRequest(`${BASE}/api/transactions?${query}`, userId).then(
      getTransactions
    ),
  ])
}

/**
 * Both list routes parse the same FilterBar params, so malformed dates must be
 * rejected identically, and neither route rejects a syntactically valid range.
 * The analytics-only month-series cap bounds materialization, not acceptance:
 * a wide span degrades to the populated months on `/api/analytics` and is
 * simply cheap on `/api/transactions`.
 */
describe("shared date-filter contract", () => {
  it("rejects malformed dates identically", async () => {
    for (const query of INVALID_DATE_QUERIES) {
      const [analytics, transactions] = await requestBoth(query)
      expect(analytics.status).toBe(400)
      expect(transactions.status).toBe(400)
      expect(await analytics.json()).toEqual(await transactions.json())
    }
  })

  it("degrades over-wide analytics spans but never rejects the range", async () => {
    seedBookedTransaction(db, userId, "tx-wide", "1950-06-15")
    for (const query of OVER_CAP_TWO_SIDED_QUERIES) {
      const [analytics, transactions] = await requestBoth(query)
      // the analytics engine materializes one bucket per populated month
      // instead of zero-filling a centuries-wide span (and never 400s: the
      // FilterBar can produce any range the user picks)
      expect(analytics.status).toBe(200)
      expect(
        (await analytics.json()).monthlyCashflow.map(
          (p: { month: string }) => p.month
        )
      ).toEqual(["1950-06"])
      // the list query never materializes months, so the wide range returns
      // the row unchanged
      expect(transactions.status).toBe(200)
      expect((await transactions.json()).total).toBe(1)
    }
  })

  it("accepts the same in-range, boundary and inverted ranges", async () => {
    for (const query of [
      "",
      "dateFrom=2026-01-01&dateTo=2026-12-31",
      "dateFrom=1926-01-01&dateTo=2025-12-31",
      "dateFrom=0000-01-01&dateTo=0000-12-31",
      "dateFrom=9999-01-01&dateTo=9999-12-31",
      "dateFrom=2026-12-31&dateTo=2026-01-01",
    ]) {
      const [analytics, transactions] = await requestBoth(query)
      expect(analytics.status).toBe(200)
      expect(transactions.status).toBe(200)
    }
  })

  it("degrades data-derived over-cap spans identically on both routes", async () => {
    seedBookedTransaction(db, userId, "tx-early", "0000-01-10")
    seedBookedTransaction(db, userId, "tx-recent", "2026-01-10")
    seedBookedTransaction(db, userId, "tx-far", "9999-12-20")

    const cases = [
      // unfiltered: the data span exceeds the cap, so the series degrades to
      // populated months instead of rejecting the default listing
      { query: "", months: ["0000-01", "2026-01", "9999-12"], total: 3 },
      {
        query: "dateFrom=2026-01-01",
        months: ["2026-01", "9999-12"],
        total: 2,
      },
      {
        query: "dateTo=2026-06-30",
        months: ["0000-01", "2026-01"],
        total: 2,
      },
    ]

    for (const { query, months, total } of cases) {
      const [analytics, transactions] = await requestBoth(query)
      expect(analytics.status).toBe(200)
      expect(transactions.status).toBe(200)
      expect(
        (await analytics.json()).monthlyCashflow.map(
          (p: { month: string }) => p.month
        )
      ).toEqual(months)
      expect((await transactions.json()).total).toBe(total)
    }
  })

  it("accepts a one-sided range whose data-derived span is at the cap", async () => {
    // data 1926-01 … 2025-12 is exactly 1200 months; today is later, so a
    // today-based pre-check would have wrongly rejected this
    seedBookedTransaction(db, userId, "tx-first", "1926-01-10")
    seedBookedTransaction(db, userId, "tx-last", "2025-12-20")

    const [analytics, transactions] = await requestBoth("dateFrom=1926-01-01")
    expect(analytics.status).toBe(200)
    expect(transactions.status).toBe(200)
    expect((await analytics.json()).monthlyCashflow).toHaveLength(1200)
  })

  it("accepts one-sided ranges whose effective span is within the cap", async () => {
    seedBookedTransaction(db, userId, "tx-recent", "2026-01-10")

    for (const query of ["dateFrom=2026-01-01", "dateTo=2026-12-31"]) {
      const [analytics, transactions] = await requestBoth(query)
      expect(analytics.status).toBe(200)
      expect(transactions.status).toBe(200)
    }
  })
})
