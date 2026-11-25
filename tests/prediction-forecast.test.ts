import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Db } from "@/lib/db"
import {
  accounts,
  importBatches,
  plannedTransactions,
  transactions,
} from "@/lib/db/schema"
import { computePredictionForecast } from "@/lib/prediction/forecast"
import { isoDatePlus, MAX_ISO_DATE } from "@/lib/dates"
import {
  resetPredictionSchedulerForTest,
  trainScope,
  waitForPredictionIdleForTest,
} from "@/lib/prediction/scheduler"
import { loadPredictionModel } from "@/lib/prediction/service"
import { seedUser, setupTestDb } from "./helpers"

let db: Db
let userId: number
let accountId: number

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  accountId = db
    .insert(accounts)
    .values({ userId, iban: "DE02120300000000202051", name: "Girokonto" })
    .returning()
    .get().id
})

function seedTx(date: string, amountCents: number, id: string) {
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId,
      bookingDate: date,
      status: "Gebucht",
      type: amountCents > 0 ? "Eingang" : "Ausgang",
      amountCents,
      sourceHash: `hash-${id}`,
    })
    .run()
}

function seedPlan(overrides: Partial<typeof plannedTransactions.$inferInsert>) {
  db.insert(plannedTransactions)
    .values({
      id: `plan-${crypto.randomUUID()}`,
      userId,
      accountId,
      amountCents: -5000,
      dtstart: "2026-02-20",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    })
    .run()
}

const TODAY = "2026-02-15"

function flatHistory() {
  let date = "2026-01-01"
  for (let i = 0; i < 46; i++) {
    seedTx(date, -1000, `tx-${i}`)
    date = isoDatePlus(date, 1)
  }
}

describe("computePredictionForecast", () => {
  it("returns the current remainder plus the next month from the daily baseline", () => {
    flatHistory()
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    expect(forecast.source).toBe("baseline")
    expect(forecast.horizon.months).toBe(2)
    expect(forecast.monthly.map((m) => m.month)).toEqual(["2026-02", "2026-03"])
    expect(forecast.monthly[0].partial).toBe(true)
    // Feb 16-28 = 13 days, March = 31 days, flat 10 €/day
    expect(forecast.monthly[0].expensesCents).toBe(13_000)
    expect(forecast.monthly[1].expensesCents).toBe(31_000)
    expect(forecast.startingBalanceCents).toBe(-46_000)
    // today + 44 forecast days
    expect(forecast.daily).toHaveLength(45)
    expect(
      forecast.daily.reduce((sum, day) => sum + day.expensesCents, 0)
    ).toBe(44_000)
    expect(forecast.projectedBalance).toHaveLength(45)
    expect(forecast.projectedBalance[0]).toEqual({
      date: TODAY,
      balanceCents: -46_000,
    })
    expect(forecast.projectedBalance.at(-1)?.balanceCents).toBe(-90_000)
  })

  it("adds active plans exactly once and skips paused plans", () => {
    flatHistory()
    seedPlan({ amountCents: -5000 })
    seedPlan({ amountCents: -9000, status: "paused" })
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    expect(forecast.monthly[0].expensesCents).toBe(18_000)
    expect(
      forecast.monthly[0].categories.reduce(
        (sum, category) => sum + category.expensesCents,
        0
      )
    ).toBe(18_000)
  })

  it("uses a known future booked row instead of the model for that day", () => {
    flatHistory()
    seedTx("2026-02-16", -100_000, "future-booked")
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    // The analytics flow scope already shows the 1.000 € booked future row
    // in its actual February bar, so the prediction overlay excludes it and
    // only carries the other 12 February baseline days.
    expect(forecast.monthly[0].expensesCents).toBe(12_000)
    expect(forecast.monthly[0].bookedFuture.expensesCents).toBe(100_000)
    expect(forecast.monthly[1].expensesCents).toBe(31_000)
    // The balance projection still includes the certain future row.
    expect(forecast.daily.find((day) => day.date === "2026-02-16")).toEqual({
      date: "2026-02-16",
      expensesCents: 0,
      incomeCents: 0,
      netCents: 0,
    })
    expect(forecast.projectedBalance.at(-1)?.balanceCents).toBe(-189_000)
  })

  it("scopes an account forecast to that account and the all-model to both", () => {
    flatHistory()
    const second = db
      .insert(accounts)
      .values({ userId, iban: "DE02120300000000202052", name: "Zweitkonto" })
      .returning()
      .get().id
    db.insert(transactions)
      .values({
        id: "second-tx",
        userId,
        accountId: second,
        bookingDate: "2026-02-01",
        status: "Gebucht",
        type: "Ausgang",
        amountCents: -500_000,
        sourceHash: "second-hash",
      })
      .run()

    const scoped = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    expect(scoped.monthly[0].expensesCents).toBe(13_000)

    const all = computePredictionForecast(userId, {
      accountId: null,
      today: TODAY,
      schedule: false,
    })
    // all-model baseline includes the 5.000 € outlier over the last 30 days
    expect(all.monthly[0].expensesCents).toBeGreaterThan(13_000)
  })

  it("falls back to the baseline when the training window becomes empty", () => {
    flatHistory()
    trainScope(userId, accountId, "2026-02-15")
    db.delete(transactions).run()
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    expect(forecast.source).toBe("baseline")
    expect(forecast.startingBalanceCents).toBe(0)
  })

  it("uses the trained artifact when one exists", () => {
    flatHistory()
    trainScope(userId, accountId, "2026-02-15")
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: "2026-03-02",
      schedule: false,
    })
    expect(forecast.source).toBe("model")
    expect(forecast.monthly).toHaveLength(2)
    expect(forecast.projectedBalance.length).toBeGreaterThan(1)
  })

  it("never counts a plan whose booking posts after the horizon", () => {
    flatHistory()
    seedPlan({ amountCents: -5_000, dtstart: "2026-03-31" })
    seedTx("2026-04-02", -5_000, "post-horizon-booking")
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    // The matcher pairs the 31 March plan with the 2 April booking, so the
    // occurrence is not projected; the booking belongs to April's actual bar.
    expect(forecast.monthly[1].expensesCents).toBe(31_000)
  })

  it("anchors the starting balance on the latest snapshot", () => {
    db.insert(importBatches)
      .values({
        id: "batch-snapshot",
        fileName: "export.csv",
        userId,
        accountId,
        status: "completed",
        snapshotDate: "2026-02-10",
        snapshotAmountCents: 100_000,
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      })
      .run()
    seedTx("2026-02-11", -1_000, "after-snapshot")
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    expect(forecast.withoutSnapshot).toBe(false)
    expect(forecast.startingBalanceCents).toBe(99_000)
  })

  it("queues training from a stale forecast read without blocking the response", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 1, 15, 12, 0, 0))
    try {
      resetPredictionSchedulerForTest()
      flatHistory()
      const forecast = computePredictionForecast(userId, {
        accountId,
        today: TODAY,
      })
      expect(forecast.source).toBe("baseline")
      expect(forecast.pending).toBe(true)
      // the request must return before the background drain starts training
      expect(loadPredictionModel(userId, accountId)).toBeNull()
      await waitForPredictionIdleForTest()
      expect(loadPredictionModel(userId, accountId)).not.toBeNull()
      resetPredictionSchedulerForTest()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stays valid for a user with no transactions", () => {
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: TODAY,
      schedule: false,
    })
    expect(forecast.source).toBe("baseline")
    expect(forecast.startingBalanceCents).toBe(0)
    expect(forecast.monthly.every((m) => m.expensesCents === 0)).toBe(true)
    expect(forecast.daily).toHaveLength(45)
    expect(
      forecast.daily.reduce((sum, day) => sum + day.expensesCents, 0)
    ).toBe(0)
    expect(forecast.projectedBalance).toHaveLength(45)
  })

  it("does not duplicate today at the storable ceiling", () => {
    const forecast = computePredictionForecast(userId, {
      accountId,
      today: MAX_ISO_DATE,
      schedule: false,
    })
    expect(forecast.daily).toHaveLength(1)
    expect(forecast.projectedBalance).toHaveLength(1)
    expect(forecast.monthly).toHaveLength(1)
    expect(forecast.daily[0].date).toBe(MAX_ISO_DATE)
  })

  it("rejects an account owned by another user", () => {
    const otherUser = seedUser(db, "user-2")
    const other = db
      .insert(accounts)
      .values({
        userId: otherUser,
        iban: "DE02120300000000202052",
        name: "Other",
      })
      .returning()
      .get().id
    expect(() =>
      computePredictionForecast(userId, {
        accountId: other,
        today: TODAY,
        schedule: false,
      })
    ).toThrow(/invalid_account/)
  })
})
