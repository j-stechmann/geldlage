import { describe, it, expect, beforeEach } from "vitest"
import { sql, type SQL } from "drizzle-orm"
import type { Db } from "@/lib/db"
import { accounts, transactions } from "@/lib/db/schema"
import { buildTimeScopedWhere, latestAnchor } from "@/lib/analytics/balance"
import { buildTransactionScope } from "@/lib/analytics/scope"
import { seedUser, setupTestDb } from "./helpers"

let db: Db
let userId: number
let otherUserId: number
let accountId: number
let otherAccountId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  otherUserId = seedUser(db, "user-2")
  accountId = db
    .insert(accounts)
    .values({ userId, iban: "DE02120300000000202051", name: "Girokonto" })
    .returning()
    .get().id
  otherAccountId = db
    .insert(accounts)
    .values({
      userId: otherUserId,
      iban: "DE02500105170137075072962",
      name: "Fremd",
    })
    .returning()
    .get().id

  for (const [date, cents] of [
    ["2026-01-10", 100],
    ["2026-01-11", 200],
    ["2026-01-12", 300],
  ] as const) {
    db.insert(transactions)
      .values({
        id: `tx-${date}`,
        userId,
        accountId,
        bookingDate: date,
        status: "Gebucht",
        type: cents > 0 ? "Eingang" : "Ausgang",
        amountCents: cents,
        sourceHash: `h-${date}`,
      })
      .run()
  }
  // pending + foreign rows must never enter the time-scoped sum
  db.insert(transactions)
    .values([
      {
        id: "tx-pending",
        userId,
        accountId,
        bookingDate: "2026-01-11",
        status: "Nicht gebucht",
        type: "Eingang",
        amountCents: 9_999,
        sourceHash: "h-pending",
      },
      {
        id: "tx-foreign",
        userId: otherUserId,
        accountId: otherAccountId,
        bookingDate: "2026-01-11",
        status: "Gebucht",
        type: "Eingang",
        amountCents: 9_999,
        sourceHash: "h-foreign",
      },
    ])
    .run()
})

function sum(where: SQL): number {
  return Number(
    db
      .select({
        sum: sql<string>`COALESCE(SUM(${transactions.amountCents}), 0)`,
      })
      .from(transactions)
      .where(where)
      .get()?.sum ?? "0"
  )
}

describe("buildTimeScopedWhere", () => {
  it("keeps the booked + user + account allowlist", () => {
    expect(sum(buildTimeScopedWhere(userId, accountId))).toBe(600)
    expect(sum(buildTimeScopedWhere(userId, undefined))).toBe(600)
  })

  it("supports inclusive from/to", () => {
    expect(
      sum(buildTimeScopedWhere(userId, accountId, { from: "2026-01-11" }))
    ).toBe(500)
    expect(
      sum(buildTimeScopedWhere(userId, accountId, { to: "2026-01-11" }))
    ).toBe(300)
  })

  it("supports exclusive after/before", () => {
    expect(
      sum(buildTimeScopedWhere(userId, accountId, { after: "2026-01-11" }))
    ).toBe(300)
    expect(
      sum(buildTimeScopedWhere(userId, accountId, { before: "2026-01-11" }))
    ).toBe(100)
    expect(
      sum(
        buildTimeScopedWhere(userId, accountId, {
          after: "2026-01-10",
          before: "2026-01-12",
        })
      )
    ).toBe(200)
  })
})

describe("buildTransactionScope", () => {
  it("applies the caller's status allowlist within the user scope", () => {
    expect(sum(buildTransactionScope({ userId, statuses: ["Gebucht"] }))).toBe(
      600
    )
    expect(
      sum(
        buildTransactionScope({
          userId,
          statuses: ["Gebucht", "Nicht gebucht"],
        })
      )
    ).toBe(10_599)
  })

  it("keeps the optional account and inclusive date bounds", () => {
    expect(
      sum(
        buildTransactionScope({
          userId,
          accountId,
          statuses: ["Gebucht"],
          dateBounds: { from: "2026-01-11", to: "2026-01-11" },
        })
      )
    ).toBe(200)
  })
})

describe("latestAnchor", () => {
  it("returns null without snapshots", () => {
    expect(latestAnchor(userId, undefined, "2026-01-31")).toBeNull()
  })
})
