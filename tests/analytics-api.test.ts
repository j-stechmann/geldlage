import { describe, it, expect, beforeEach } from "vitest"
import { GET as getAnalytics } from "@/app/api/analytics/route"
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

function getAnalyticsQuery(query: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/analytics?${query}`, uid).then(getAnalytics)
}

describe("GET /api/analytics date filters", () => {
  it("rejects malformed or unrepresentable date filters", async () => {
    for (const query of INVALID_DATE_QUERIES) {
      const res = await getAnalyticsQuery(query)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: "invalid_date" })
    }
  })

  it("rejects explicit ranges wider than the month cap", async () => {
    for (const query of OVER_CAP_TWO_SIDED_QUERIES) {
      const res = await getAnalyticsQuery(query)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: "range_too_large" })
    }
  })

  it("accepts absent, empty, in-range and boundary date filters", async () => {
    for (const query of [
      "",
      "dateFrom=&dateTo=",
      "dateFrom=2026-01-01&dateTo=2026-12-31",
      // exactly the 1200-month cap
      "dateFrom=1926-01-01&dateTo=2025-12-31",
      // representable extremes, short ranges
      "dateFrom=0000-01-01&dateTo=0000-12-31",
      "dateFrom=9999-01-01&dateTo=9999-12-31",
      // one-sided ranges are data-derived, never request-capped
      "dateFrom=0001-01-01",
      "dateTo=9999-12-31",
    ]) {
      const res = await getAnalyticsQuery(query)
      expect(res.status).toBe(200)
    }
  })

  it("degrades a data-derived span over the cap to populated months", async () => {
    seedBookedTransaction(db, userId, "tx-2026", "2026-01-10")
    seedBookedTransaction(db, userId, "tx-9999", "9999-12-20")

    const res = await getAnalyticsQuery("dateFrom=2026-01-01")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      monthlyCashflow: [{ month: "2026-01" }, { month: "9999-12" }],
    })
  })
})
