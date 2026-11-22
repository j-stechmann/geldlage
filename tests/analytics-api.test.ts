import { describe, it, expect, beforeEach } from "vitest"
import { GET as getAnalytics } from "@/app/api/analytics/route"
import { authedRequest, setupTestDb } from "./helpers"

const BASE = "http://localhost:3000"

let userId: number

beforeEach(() => {
  ;({ userId } = setupTestDb())
})

function getAnalyticsQuery(query: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/analytics?${query}`, uid).then(getAnalytics)
}

describe("GET /api/analytics date filters", () => {
  it("rejects malformed or out-of-range date filters", async () => {
    for (const query of [
      "dateFrom=nope",
      "dateTo=2026-02-29",
      "dateFrom=0000-12-31",
      "dateTo=9999-01-01",
    ]) {
      const res = await getAnalyticsQuery(query)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: "invalid_date" })
    }
  })

  it("accepts absent, empty, and in-range date filters", async () => {
    for (const query of [
      "",
      "dateFrom=&dateTo=",
      "dateFrom=2026-01-01&dateTo=2026-12-31",
      "dateFrom=0001-01-01&dateTo=9998-12-31",
    ]) {
      const res = await getAnalyticsQuery(query)
      expect(res.status).toBe(200)
    }
  })
})
