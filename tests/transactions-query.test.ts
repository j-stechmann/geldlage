import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { seedUser } from "./helpers"
import { parseDkbCsv } from "@/lib/csv/parser"
import {
  accounts,
  importBatches,
  transactions,
  categories,
} from "@/lib/db/schema"
import { computeDedupe } from "@/lib/db/dedupe"
import {
  parseFilters,
  queryTransactions,
  type TransactionPage,
} from "@/lib/analytics/queries"

const fixtureDir = join(__dirname, "fixtures")
const csv = readFileSync(join(fixtureDir, "fixture.csv"), "utf8")

let db: Db
let userId: number
let accountId: number

beforeAll(() => {
  db = createTestDb()
  setTestDb(db)
  userId = seedUser(db)

  const parsed = parseDkbCsv(csv)
  const account = db
    .insert(accounts)
    .values({ userId, iban: parsed.accountIban, name: parsed.accountName })
    .returning()
    .get()
  accountId = account.id

  db.insert(importBatches)
    .values({
      userId,
      id: "fixture-batch",
      fileName: "fixture.csv",
      accountId: account.id,
      status: "importing",
      rowsTotal: parsed.rows.length,
    })
    .returning()
    .get()

  const dedupe = computeDedupe(
    parsed.accountIban,
    userId,
    account.id,
    "fixture-batch",
    parsed.rows,
    new Map()
  )
  db.transaction((tx) => {
    for (const row of dedupe.toInsert) {
      tx.insert(transactions).values(row).run()
    }
  })

  // label one transaction so category fields are populated
  const cat = db
    .insert(categories)
    .values({
      userId,
      name: "Test",
      nameKey: "test",
      language: "de",
      origin: "manual",
      color: null,
    })
    .returning()
    .get()
  const first = db.select().from(transactions).limit(1).get()
  db.update(transactions)
    .set({ categoryId: cat.id, labelStatus: "labeled" })
    .where(eq(transactions.id, first!.id))
    .run()
})

describe("queryTransactions extended fields", () => {
  it("returns the new columns incl. account name and refs", () => {
    const page: TransactionPage = queryTransactions(
      parseFilters(new URLSearchParams()),
      userId,
      1,
      25
    )
    expect(page.rows.length).toBeGreaterThan(0)
    for (const row of page.rows) {
      expect(row).toHaveProperty("creditorId")
      expect(row).toHaveProperty("mandateRef")
      expect(row).toHaveProperty("customerRef")
      expect(row).toHaveProperty("accountId")
      expect(row.accountName).toBe("Girokonto")
    }
  })

  it("sorts by value_date", () => {
    const asc = queryTransactions(
      parseFilters(new URLSearchParams("sort=value_date&dir=asc")),
      userId,
      1,
      25
    )
    const dates = asc.rows.map((r) => r.valueDate)
    const sorted = [...dates].sort((a, b) => (a ?? "").localeCompare(b ?? ""))
    expect(dates).toEqual(sorted)
  })

  it("sorts by status", () => {
    const page = queryTransactions(
      parseFilters(new URLSearchParams("sort=status&dir=desc")),
      userId,
      1,
      25
    )
    expect(page.rows.length).toBeGreaterThan(0)
    const statuses = page.rows.map((r) => r.status)
    const sorted = [...statuses].sort((a, b) => b.localeCompare(a))
    expect(statuses).toEqual(sorted)
  })

  it("filters by account", () => {
    const page = queryTransactions(
      parseFilters(new URLSearchParams(`accountId=${accountId}`)),
      userId,
      1,
      25
    )
    expect(page.total).toBeGreaterThan(0)
    expect(new Set(page.rows.map((r) => r.accountId))).toEqual(
      new Set([accountId])
    )

    const none = queryTransactions(
      parseFilters(new URLSearchParams("accountId=9999")),
      userId,
      1,
      25
    )
    expect(none.total).toBe(0)
  })

  it("filters by status=all and labelStatus", () => {
    const all = queryTransactions(
      parseFilters(new URLSearchParams("status=all")),
      userId,
      1,
      100
    )
    const gebucht = queryTransactions(
      parseFilters(new URLSearchParams()),
      userId,
      1,
      100
    )
    expect(all.total).toBeGreaterThanOrEqual(gebucht.total)

    const labeled = queryTransactions(
      parseFilters(new URLSearchParams("labelStatus=labeled")),
      userId,
      1,
      100
    )
    expect(labeled.total).toBe(1)
    expect(labeled.rows[0]?.categoryId).not.toBeNull()
  })
})
