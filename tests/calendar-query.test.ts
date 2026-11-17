import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import { accounts, transactions } from "@/lib/db/schema"
import { queryCalendarTransactions } from "@/lib/analytics/queries"
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

  db.insert(transactions)
    .values([
      {
        id: "tx-booked",
        userId,
        accountId,
        bookingDate: "2026-01-02",
        status: "Gebucht",
        type: "Ausgang",
        payer: "Max",
        payee: "Mietwerk",
        purpose: "Miete",
        amountCents: -950_00,
        sourceHash: "h-booked",
      },
      {
        id: "tx-pending",
        userId,
        accountId,
        bookingDate: "2026-01-01",
        status: "Nicht gebucht",
        type: "Eingang",
        payer: "Arbeitgeber",
        payee: "Max",
        purpose: "Gehalt",
        amountCents: 2_000_00,
        sourceHash: "h-pending",
      },
      {
        id: "tx-foreign",
        userId: otherUserId,
        accountId: otherAccountId,
        bookingDate: "2026-01-01",
        status: "Gebucht",
        type: "Ausgang",
        payer: null,
        payee: "Fremd",
        purpose: null,
        amountCents: -1_00,
        sourceHash: "h-foreign",
      },
    ])
    .run()
})

describe("queryCalendarTransactions", () => {
  it("returns booked and pending rows, user-scoped, ordered by date", () => {
    const rows = queryCalendarTransactions(userId, {
      from: "2026-01-01",
      to: "2026-01-31",
    })
    expect(rows.map((r) => r.id)).toEqual(["tx-pending", "tx-booked"])
    expect(rows[0]).toMatchObject({
      status: "Nicht gebucht",
      counterparty: "Arbeitgeber", // payer for Eingang
    })
    expect(rows[1]).toMatchObject({
      status: "Gebucht",
      counterparty: "Mietwerk", // payee for Ausgang
    })
  })

  it("respects the window and the optional account filter", () => {
    expect(
      queryCalendarTransactions(userId, {
        from: "2026-01-02",
        to: "2026-01-02",
      })
    ).toHaveLength(1)
    expect(
      queryCalendarTransactions(
        userId,
        { from: "2026-01-01", to: "2026-01-31" },
        accountId
      )
    ).toHaveLength(2)
    expect(
      queryCalendarTransactions(
        otherUserId,
        { from: "2026-01-01", to: "2026-01-31" },
        otherAccountId
      )
    ).toHaveLength(1)
  })
})
