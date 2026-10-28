import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import { accounts, importBatches, transactions } from "@/lib/db/schema"
import { computeAnalytics } from "@/lib/analytics/engine"
import { parseFilters } from "@/lib/analytics/queries"
import { setupTestDb } from "./helpers"

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
})

function seedBatch(overrides: Partial<typeof importBatches.$inferInsert> = {}) {
  return db
    .insert(importBatches)
    .values({
      id: `batch-${crypto.randomUUID()}`,
      fileName: "export.csv",
      userId,
      accountId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    })
    .returning()
    .get()
}

function seedTx(bookingDate: string, amountCents: number) {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId,
      bookingDate,
      status: "Gebucht",
      payer: "Gehaltsabrechnung GmbH",
      type: amountCents > 0 ? "Eingang" : "Ausgang",
      amountCents,
      sourceHash: `hash-${id}`,
    })
    .run()
}

/**
 * latestAnchor's same-snapshotDate tie (two batches of one day, e.g. a
 * second account's CSV imported later) used to be scan-order luck. The rule
 * is now explicit — freshest import wins (createdAt, then id) — and must
 * AGREE with computeForecast's anchor, or the balance KPI line and the
 * forecast starting balance would silently name different snapshots.
 */
describe("latestAnchor snapshotDate ties", () => {
  it("picks the freshest batch on a snapshotDate tie (not scan order)", () => {
    seedBatch({ snapshotDate: "2025-06-30", snapshotAmountCents: 10_000 })
    // the earlier-imported (10:00) batch is inserted first: the old
    // first-in-scan-order pick answered 100_000 here
    seedBatch({
      id: "batch-tie-z",
      createdAt: "2026-02-01T10:00:00.000Z",
      updatedAt: "2026-02-01T10:00:00.000Z",
      snapshotDate: "2026-01-31",
      snapshotAmountCents: 100_000,
    })
    seedBatch({
      id: "batch-tie-a",
      createdAt: "2026-02-01T18:00:00.000Z",
      updatedAt: "2026-02-01T18:00:00.000Z",
      snapshotDate: "2026-01-31",
      snapshotAmountCents: 300_000,
    })
    seedTx("2026-02-05", -50_000)

    const analytics = computeAnalytics(
      parseFilters(new URLSearchParams()),
      userId,
      "2026-02-15"
    )
    // 18:00 batch (300k) + the booked drift after 2026-01-31
    expect(analytics.kpis.currentBalanceCents).toBe(300_000 - 50_000)
  })

  it("ties down to id when createdAt is equal, deterministically", () => {
    seedBatch({ snapshotDate: "2025-06-30", snapshotAmountCents: 10_000 })
    seedBatch({
      id: "batch-tie-a",
      snapshotDate: "2026-01-31",
      snapshotAmountCents: 100_000,
    })
    seedBatch({
      id: "batch-tie-z",
      snapshotDate: "2026-01-31",
      snapshotAmountCents: 300_000,
    })

    const analytics = computeAnalytics(
      parseFilters(new URLSearchParams()),
      userId,
      "2026-02-15"
    )
    // same createdAt (default) → the higher id wins on both sides: engine
    // KPI and forecast anchor stay in agreement
    expect(analytics.kpis.currentBalanceCents).toBe(300_000)
  })
})
