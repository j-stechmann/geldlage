import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { eq } from "drizzle-orm"
import type { Db } from "@/lib/db"
import {
  accounts,
  categories,
  plannedTransactions,
  predictionModels,
  transactions,
} from "@/lib/db/schema"
import { isoDatePlus } from "@/lib/dates"
import { loadCategoryShares, loadDailyDataset } from "@/lib/prediction/dataset"
import {
  notifyAccountCreated,
  notifyAccountDeleted,
  notifyImportCommitted,
  notifyPlanChanged,
} from "@/lib/prediction/triggers"
import {
  artifactChecksum,
  deletePredictionModel,
  loadPredictionModel,
  markFailed,
  markTraining,
  predictionRetryDue,
  resetInterruptedPredictionModels,
  scopeKey,
} from "@/lib/prediction/service"
import {
  predictionQueueSizeForTest,
  predictionRetryTimerCountForTest,
  resetPredictionSchedulerForTest,
  scheduleIfStale,
  schedulePredictionTraining,
  trainScope,
  waitForPredictionIdleForTest,
} from "@/lib/prediction/scheduler"
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

function seedDays(days: number, start = "2026-01-01") {
  let date = start
  for (let i = 0; i < days; i++) {
    db.insert(transactions)
      .values({
        id: `tx-${i}-${date}`,
        userId,
        accountId,
        bookingDate: date,
        status: "Gebucht",
        type: "Ausgang",
        amountCents: -(1000 + (i % 5) * 100),
        sourceHash: `hash-${i}-${date}`,
      })
      .run()
    date = isoDatePlus(date, 1)
  }
}

describe("automatic prediction training", () => {
  it("does nothing before one month of data exists", () => {
    seedDays(20)
    trainScope(userId, accountId, "2026-02-01")
    expect(loadPredictionModel(userId, accountId)).toBeNull()
  })

  it("trains automatically from one month of partial-month history", () => {
    seedDays(28, "2026-02-10")
    trainScope(userId, accountId, "2026-03-10")
    const model = loadPredictionModel(userId, accountId)
    expect(model).not.toBeNull()
    expect(model!.scope.accountId).toBe(accountId)
    expect(model!.artifact.data.days).toBe(28)
    expect(model!.status).toBe("ready")
    // one current model per scope
    expect(
      db
        .select()
        .from(predictionModels)
        .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
        .all()
    ).toHaveLength(1)
  })

  it("skips retraining when the data signature has not changed", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const first = loadPredictionModel(userId, accountId)!
    trainScope(userId, accountId, "2026-02-01")
    const second = loadPredictionModel(userId, accountId)!
    expect(second.trainedAt).toBe(first.trainedAt)
    expect(second.dataSignature).toBe(first.dataSignature)
  })

  it("retrains when a new transaction changes the signature", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const first = loadPredictionModel(userId, accountId)!
    db.insert(transactions)
      .values({
        id: "new-tx",
        userId,
        accountId,
        bookingDate: "2026-02-01",
        status: "Gebucht",
        type: "Ausgang",
        amountCents: -99_999,
        sourceHash: "new-hash",
      })
      .run()
    trainScope(userId, accountId, "2026-02-01")
    const second = loadPredictionModel(userId, accountId)!
    expect(second.dataSignature).not.toBe(first.dataSignature)
    expect(second.artifact.data.transactionCount).toBe(
      first.artifact.data.transactionCount + 1
    )
  })

  it("retrains when the active-plan definition changes", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const before = loadPredictionModel(userId, accountId)!
    db.insert(plannedTransactions)
      .values({
        id: "future-rent",
        userId,
        accountId,
        amountCents: -120_000,
        dtstart: "2026-02-01",
        rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run()
    trainScope(userId, accountId, "2026-02-01")
    const after = loadPredictionModel(userId, accountId)!
    expect(after.planSignature).not.toBe(before.planSignature)
    expect(after.dataSignature).not.toBe(before.dataSignature)
  })

  it("keeps the all-accounts model separate from account models", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    trainScope(userId, null, "2026-02-01")
    expect(loadPredictionModel(userId, accountId)?.scope.accountId).toBe(
      accountId
    )
    expect(loadPredictionModel(userId, null)?.scope.accountId).toBeNull()
  })

  it("accepts a legacy tweedie-daily algorithm artifact", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const model = loadPredictionModel(userId, accountId)!
    const legacy = {
      ...model.artifact,
      expense: {
        ...model.artifact.expense,
        algorithm: "tweedie-daily" as const,
      },
    }
    const json = JSON.stringify(legacy)
    db.update(predictionModels)
      .set({ artifactJson: json, checksum: artifactChecksum(json) })
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .run()
    expect(loadPredictionModel(userId, accountId)).not.toBeNull()
  })

  it("treats a null nested artifact payload as absent", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const model = loadPredictionModel(userId, accountId)!
    const bad = JSON.stringify({ ...model.artifact, data: null })
    db.update(predictionModels)
      .set({ artifactJson: bad, checksum: artifactChecksum(bad) })
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .run()
    expect(loadPredictionModel(userId, accountId)).toBeNull()
  })

  it("treats a null feature set as absent", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const model = loadPredictionModel(userId, accountId)!
    for (const field of ["expense", "income"] as const) {
      const bad = JSON.stringify({ ...model.artifact, [field]: null })
      db.update(predictionModels)
        .set({ artifactJson: bad, checksum: artifactChecksum(bad) })
        .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
        .run()
      expect(loadPredictionModel(userId, accountId)).toBeNull()
      db.update(predictionModels)
        .set({
          artifactJson: JSON.stringify(model.artifact),
          checksum: artifactChecksum(JSON.stringify(model.artifact)),
        })
        .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
        .run()
    }
  })

  it("treats a null feature model as absent", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const model = loadPredictionModel(userId, accountId)!
    for (const field of ["expense", "income"] as const) {
      const bad = JSON.stringify({
        ...model.artifact,
        [field]: { ...model.artifact[field], model: null },
      })
      db.update(predictionModels)
        .set({ artifactJson: bad, checksum: artifactChecksum(bad) })
        .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
        .run()
      expect(loadPredictionModel(userId, accountId)).toBeNull()
      // restore for the second direction
      db.update(predictionModels)
        .set({
          artifactJson: JSON.stringify(model.artifact),
          checksum: artifactChecksum(JSON.stringify(model.artifact)),
        })
        .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
        .run()
    }
  })

  it("treats a corrupt artifact as absent", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    db.update(predictionModels)
      .set({ artifactJson: "{}" })
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .run()
    expect(loadPredictionModel(userId, accountId)).toBeNull()
  })

  it("recovers interrupted training rows on startup", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    db.update(predictionModels)
      .set({ status: "training" })
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .run()
    expect(resetInterruptedPredictionModels()).toBe(1)
    expect(loadPredictionModel(userId, accountId)?.status).toBe("failed")
  })

  it("isolates models by user", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    const other = seedUser(db, "user-2")
    expect(loadPredictionModel(other, accountId)).toBeNull()
    expect(deletePredictionModel(other, accountId)).toBe(0)
  })

  it("enforces the account/scope identity check", () => {
    expect(() =>
      db
        .insert(predictionModels)
        .values({
          id: "bad-scope",
          userId,
          accountId: null,
          scopeKey: `account:${accountId}`,
          status: "ready",
          algorithm: "tweedie-daily-v1",
          featureVersion: 1,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        })
        .run()
    ).toThrow(/CHECK constraint failed/)
  })

  it("skips a stale-read enqueue while the failure backoff is active", async () => {
    resetPredictionSchedulerForTest()
    seedDays(30)
    markFailed(userId, accountId, "boom")
    const dataset = loadDailyDataset(userId, accountId, "2026-02-01")!
    scheduleIfStale(userId, accountId, dataset)
    await waitForPredictionIdleForTest()
    expect(loadPredictionModel(userId, accountId)).toBeNull()
    resetPredictionSchedulerForTest()
  })

  it("lets an explicit data-change trigger bypass the failure backoff", () => {
    seedDays(30)
    markFailed(userId, accountId, "boom")
    expect(predictionRetryDue(userId, accountId)).toBe(false)
    trainScope(userId, accountId, "2026-02-01", true)
    expect(loadPredictionModel(userId, accountId)).not.toBeNull()
  })

  it("re-arms the retry wakeup for a persisted backed-off scope", async () => {
    resetPredictionSchedulerForTest()
    seedDays(30)
    markFailed(userId, accountId, "boom")
    schedulePredictionTraining(userId, accountId)
    await waitForPredictionIdleForTest()
    expect(predictionRetryTimerCountForTest()).toBe(1)
    resetPredictionSchedulerForTest()
  })

  it("forces a retrain through the real plan trigger", async () => {
    resetPredictionSchedulerForTest()
    seedDays(30)
    markFailed(userId, accountId, "boom")
    notifyPlanChanged(userId, accountId)
    await waitForPredictionIdleForTest()
    expect(loadPredictionModel(userId, accountId)).not.toBeNull()
    resetPredictionSchedulerForTest()
  })

  it("fires the retry wakeup and forces a fresh train", async () => {
    resetPredictionSchedulerForTest()
    seedDays(30)
    markFailed(userId, accountId, "boom")
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      schedulePredictionTraining(userId, accountId)
      await waitForPredictionIdleForTest()
      expect(predictionRetryTimerCountForTest()).toBe(1)
      vi.advanceTimersByTime(61_000)
      await waitForPredictionIdleForTest()
      expect(loadPredictionModel(userId, accountId)).not.toBeNull()
    } finally {
      vi.useRealTimers()
      resetPredictionSchedulerForTest()
    }
  })

  it("fans out account/import triggers to the expected scopes", () => {
    resetPredictionSchedulerForTest()
    notifyAccountCreated(userId, accountId)
    expect(predictionQueueSizeForTest()).toBe(2)
    resetPredictionSchedulerForTest()

    notifyImportCommitted(userId, accountId)
    expect(predictionQueueSizeForTest()).toBe(2)
    resetPredictionSchedulerForTest()

    notifyAccountDeleted(userId, accountId)
    expect(predictionQueueSizeForTest()).toBe(1)
    resetPredictionSchedulerForTest()
  })

  it("coalesces duplicate queue requests for the same scope", async () => {
    resetPredictionSchedulerForTest()
    seedDays(30)
    schedulePredictionTraining(userId, accountId)
    schedulePredictionTraining(userId, accountId)
    expect(predictionQueueSizeForTest()).toBe(1)
    await waitForPredictionIdleForTest()
    expect(
      db
        .select()
        .from(predictionModels)
        .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
        .all()
    ).toHaveLength(1)
    resetPredictionSchedulerForTest()
  })

  it("excludes explicitly matched transactions from category shares", () => {
    seedDays(30)
    const catA = db
      .insert(categories)
      .values({
        userId,
        name: "A",
        nameKey: "a",
        language: "de",
        origin: "manual",
      })
      .returning()
      .get().id
    const catB = db
      .insert(categories)
      .values({
        userId,
        name: "B",
        nameKey: "b",
        language: "de",
        origin: "manual",
      })
      .returning()
      .get().id
    db.update(transactions)
      .set({ categoryId: catA })
      .where(eq(transactions.id, "tx-0-2026-01-01"))
      .run()
    db.update(transactions)
      .set({ categoryId: catB })
      .where(eq(transactions.id, "tx-1-2026-01-02"))
      .run()
    const withAll = loadCategoryShares(userId, accountId, "2026-01-30")
    expect(withAll.find((share) => share.categoryId === catA)).toBeDefined()
    const withoutA = loadCategoryShares(
      userId,
      accountId,
      "2026-01-30",
      new Set(["tx-0-2026-01-01"])
    )
    expect(withoutA.find((share) => share.categoryId === catA)).toBeUndefined()
    expect(withoutA.find((share) => share.categoryId === catB)).toBeDefined()
  })

  it("deletes the model for a scope", () => {
    seedDays(30)
    trainScope(userId, accountId, "2026-02-01")
    expect(deletePredictionModel(userId, accountId)).toBe(1)
    expect(loadPredictionModel(userId, accountId)).toBeNull()
  })

  it("trains in the background when the scheduler is asked for a scope", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 1, 1, 12, 0, 0))
    try {
      resetPredictionSchedulerForTest()
      seedDays(30)
      schedulePredictionTraining(userId, accountId)
      await waitForPredictionIdleForTest()
      expect(loadPredictionModel(userId, accountId)).not.toBeNull()
      resetPredictionSchedulerForTest()
    } finally {
      vi.useRealTimers()
    }
  })

  it("records a failure before the first artifact and backs off", () => {
    seedDays(30)
    markFailed(userId, accountId, "first fit failed")
    const row = db
      .select()
      .from(predictionModels)
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .get()
    expect(row?.status).toBe("failed")
    expect(row?.attempts).toBe(1)
    expect(row?.nextRetryAt).toBeTruthy()
    expect(predictionRetryDue(userId, accountId)).toBe(false)
    // force the backoff window open and mark a new attempt
    db.update(predictionModels)
      .set({ nextRetryAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .run()
    expect(predictionRetryDue(userId, accountId)).toBe(true)
    markTraining(userId, accountId)
    const training = db
      .select()
      .from(predictionModels)
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .get()
    expect(training?.status).toBe("training")
    expect(training?.attempts).toBe(1)
    expect(loadPredictionModel(userId, accountId)).toBeNull()
  })

  it("excludes transactions already matched to an active plan from the residual", () => {
    seedDays(30)
    db.insert(plannedTransactions)
      .values({
        id: "rent-plan",
        userId,
        accountId,
        counterparty: "Rent",
        amountCents: -1000,
        dtstart: "2026-01-15",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run()
    db.update(transactions)
      .set({ payee: "Rent" })
      .where(eq(transactions.id, "tx-14-2026-01-15"))
      .run()
    const dataset = loadDailyDataset(userId, accountId, "2026-01-30")!
    const day = dataset.series.find((point) => point.date === "2026-01-15")
    expect(day?.expenseCents).toBe(0)
  })

  it("matches a plan due tomorrow to today's booking in the residual", () => {
    seedDays(30)
    db.delete(transactions).where(eq(transactions.id, "tx-15-2026-01-16")).run()
    db.insert(plannedTransactions)
      .values({
        id: "tomorrow-plan",
        userId,
        accountId,
        amountCents: -1400,
        dtstart: "2026-01-16",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run()
    const dataset = loadDailyDataset(userId, accountId, "2026-01-15")!
    const day = dataset.series.find((point) => point.date === "2026-01-15")
    expect(day?.expenseCents).toBe(0)
  })

  it("does not mix another user's bookings into the all-accounts dataset", () => {
    seedDays(30)
    const other = seedUser(db, "user-2")
    const otherAccount = db
      .insert(accounts)
      .values({
        userId: other,
        iban: "DE02120300000000202052",
        name: "Other",
      })
      .returning()
      .get().id
    db.insert(transactions)
      .values({
        id: "other-tx",
        userId: other,
        accountId: otherAccount,
        bookingDate: "2026-01-10",
        status: "Gebucht",
        type: "Ausgang",
        amountCents: -999_999,
        sourceHash: "other-hash",
      })
      .run()
    const dataset = loadDailyDataset(userId, null, "2026-01-30")!
    expect(dataset.transactionCount).toBe(30)
  })

  it("backs off exponentially and caps at one hour", () => {
    markFailed(userId, accountId, "one")
    let row = db
      .select()
      .from(predictionModels)
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .get()!
    const firstDelay = Date.parse(row.nextRetryAt!) - Date.now()
    markFailed(userId, accountId, "two")
    row = db
      .select()
      .from(predictionModels)
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .get()!
    expect(row.attempts).toBe(2)
    expect(Date.parse(row.nextRetryAt!) - Date.now()).toBeGreaterThan(
      firstDelay
    )
    db.update(predictionModels)
      .set({ attempts: 20 })
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .run()
    markFailed(userId, accountId, "cap")
    row = db
      .select()
      .from(predictionModels)
      .where(eq(predictionModels.scopeKey, scopeKey(accountId)))
      .get()!
    expect(Date.parse(row.nextRetryAt!) - Date.now()).toBeLessThanOrEqual(
      60 * 60_000 + 1000
    )
  })

  it("exposes the exact daily dataset the model trained on", () => {
    seedDays(30)
    const dataset = loadDailyDataset(userId, accountId, "2026-01-30")!
    expect(dataset.series).toHaveLength(30)
    expect(dataset.series[0].date).toBe("2026-01-01")
    expect(dataset.series.at(-1)?.date).toBe("2026-01-30")
  })
})
