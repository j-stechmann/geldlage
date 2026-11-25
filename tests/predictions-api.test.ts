import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import type { Db } from "@/lib/db"
import { accounts, transactions } from "@/lib/db/schema"
import { GET as getPrediction } from "@/app/api/predictions/forecast/route"
import { isoDatePlus } from "@/lib/dates"
import { markFailed } from "@/lib/prediction/service"
import {
  resetPredictionSchedulerForTest,
  waitForPredictionIdleForTest,
} from "@/lib/prediction/scheduler"
import { authedRequest, seedUser, setupTestDb } from "./helpers"

const BASE = "http://localhost:3000"

let db: Db
let userId: number
let otherUserId: number
let accountId: number

afterEach(async () => {
  await waitForPredictionIdleForTest()
  resetPredictionSchedulerForTest()
})

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  otherUserId = seedUser(db, "user-2")
  accountId = db
    .insert(accounts)
    .values({ userId, iban: "DE02120300000000202051", name: "Girokonto" })
    .returning()
    .get().id
})

function request(url: string, uid: number = userId) {
  return authedRequest(`${BASE}${url}`, uid).then((req) => getPrediction(req))
}

function anon(url: string) {
  return getPrediction(new NextRequest(`${BASE}${url}`))
}

describe("GET /api/predictions/forecast", () => {
  it("401 without a session", async () => {
    expect((await anon("/api/predictions/forecast")).status).toBe(401)
  })

  it("400 on malformed account ids", async () => {
    for (const raw of ["12.9", "12abc", "-1", "0"]) {
      const res = await request(`/api/predictions/forecast?accountId=${raw}`)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe("invalid_account")
    }
  })

  it("400 for an account owned by another user", async () => {
    const otherAccount = db
      .insert(accounts)
      .values({
        userId: otherUserId,
        iban: "DE02120300000000202052",
        name: "Other",
      })
      .returning()
      .get().id
    const res = await request(
      `/api/predictions/forecast?accountId=${otherAccount}`,
      userId
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_account")
  })

  it("always returns the two-month envelope, even without data or a model", async () => {
    const res = await request("/api/predictions/forecast")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.prediction).toMatchObject({
      source: "baseline",
      horizon: { months: 2 },
      monthly: expect.any(Array),
      projectedBalance: expect.any(Array),
      startingBalanceCents: 0,
      withoutSnapshot: true,
    })
    expect(data.prediction.monthly).toHaveLength(2)
    expect(data.prediction.daily.length).toBeGreaterThan(0)
    expect(data.prediction.pending).toBe(false)
  })

  it("marks a trainable scope as pending until the model exists", async () => {
    let date = "2026-01-01"
    for (let i = 0; i < 28; i++) {
      db.insert(transactions)
        .values({
          id: `pending-${i}`,
          userId,
          accountId,
          bookingDate: date,
          status: "Gebucht",
          type: "Ausgang",
          amountCents: -1000,
          sourceHash: `pending-hash-${i}`,
        })
        .run()
      date = isoDatePlus(date, 1)
    }
    const res = await request(
      `/api/predictions/forecast?accountId=${accountId}`
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.prediction.source).toBe("baseline")
    expect(data.prediction.pending).toBe(true)
    expect(data.prediction.retryAt).toBeNull()
  })

  it("exposes the backoff retry instant while a failed scope waits", async () => {
    let date = "2026-01-01"
    for (let i = 0; i < 28; i++) {
      db.insert(transactions)
        .values({
          id: `backoff-${i}`,
          userId,
          accountId,
          bookingDate: date,
          status: "Gebucht",
          type: "Ausgang",
          amountCents: -1000,
          sourceHash: `backoff-hash-${i}`,
        })
        .run()
      date = isoDatePlus(date, 1)
    }
    markFailed(userId, accountId, "boom")
    const res = await request(
      `/api/predictions/forecast?accountId=${accountId}`
    )
    const data = await res.json()
    expect(data.prediction.pending).toBe(true)
    expect(data.prediction.retryAt).toEqual(expect.any(String))
  })

  it("scopes the prediction to the requested owned account", async () => {
    let date = "2026-01-01"
    for (let i = 0; i < 5; i++) {
      db.insert(transactions)
        .values({
          id: `tx-${i}`,
          userId,
          accountId,
          bookingDate: date,
          status: "Gebucht",
          type: "Ausgang",
          amountCents: -1000,
          sourceHash: `hash-${i}`,
        })
        .run()
      date = isoDatePlus(date, 1)
    }
    const res = await request(
      `/api/predictions/forecast?accountId=${accountId}`
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.prediction.startingBalanceCents).toBe(-5_000)
    expect(data.prediction.monthly.length).toBe(2)
  })
})
