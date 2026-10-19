import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { getTableColumns } from "drizzle-orm"
import type { Db } from "@/lib/db"
import { createSchemaSqlite } from "@/lib/db"
import * as schema from "@/lib/db/schema"
import { accounts, categories, transactions } from "@/lib/db/schema"
import { parseQuery, QUERY_OPS } from "@/lib/agent/query/parse"
import type { QueryResult } from "@/lib/agent/query/compile"
import { createReadOnlyDb } from "@/lib/agent/query/readonly-db"
import { queryDataPromptDoc } from "@/lib/agent/query/prompt-doc"
import { queryTables } from "@/lib/agent/query/catalog"
import { query_data } from "@/lib/agent/tools/query-data"
import { seedUser, setupTestDb } from "./helpers"

let db: Db
let uid1: number
let uid2: number
let cat1: number
let cat2: number

const accountIds = new Map<number, number>()
function accountIdFor(userId: number): number {
  let id = accountIds.get(userId)
  if (!id) {
    id = db
      .insert(accounts)
      .values({ userId, iban: `DE00${userId}`, name: "Konto" })
      .returning()
      .get().id
    accountIds.set(userId, id)
  }
  return id
}

function seedTx(opts: {
  userId: number
  categoryId?: number | null
  amountCents: number
  bookingDate: string
  payee?: string
  payer?: string
  purpose?: string
  status?: string
}): void {
  db.insert(transactions)
    .values({
      id: `tx-${crypto.randomUUID()}`,
      userId: opts.userId,
      accountId: accountIdFor(opts.userId),
      bookingDate: opts.bookingDate,
      status: opts.status ?? "Gebucht",
      payer: opts.payer ?? "P",
      payee: opts.payee ?? "Q",
      purpose: opts.purpose ?? null,
      type: opts.amountCents < 0 ? "Ausgang" : "Eingang",
      amountCents: opts.amountCents,
      sourceHash: `hash-${crypto.randomUUID()}`,
      labelStatus: "labeled",
      categoryId: opts.categoryId ?? null,
    })
    .run()
}

/** Result of an execute call through the tool (full error transparency). */
async function run(args: unknown, uid = uid1): Promise<QueryResult> {
  return (await query_data.execute(args, { uid })) as QueryResult
}

/** A thrown tool execute → the executor's {"error": …} shape. */
async function failArgs(args: unknown, uid = uid1): Promise<string> {
  try {
    await query_data.execute(args, { uid })
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error("expected execute to throw")
}

beforeEach(() => {
  ;({ db, userId: uid1 } = setupTestDb())
  uid2 = seedUser(db, "user-2")
  accountIds.clear()
  cat1 = db
    .insert(categories)
    .values({
      userId: uid1,
      name: "Lebensmittel",
      nameKey: "lebensmittel",
      language: "de",
    })
    .returning()
    .get().id
  cat2 = db
    .insert(categories)
    .values({ userId: uid1, name: "Reisen", nameKey: "reisen", language: "de" })
    .returning()
    .get().id
})

describe("query catalog integrity", () => {
  it("exposes exactly the financial domain tables (no users/chat)", () => {
    expect(Object.keys(queryTables).sort()).toEqual([
      "accounts",
      "categories",
      "import_batches",
      "label_rules",
      "transactions",
    ])
  })

  it("every exposed column exists on the drizzle table; user_id never exposed", () => {
    for (const [name, def] of Object.entries(queryTables)) {
      const columns = getTableColumns(def.table)
      // userIdColumn must be the real user_id column of that table
      expect(Object.values(columns)).toContain(def.userIdColumn)
      for (const [key, col] of Object.entries(def.columns)) {
        // derived exprs (SQL) and real columns both allowed
        if (key === "booking_month" || key === "booking_year") {
          continue
        }
        expect(Object.values(columns), `${name}.${key}`).toContain(col.expr)
      }
      for (const key of Object.keys(def.columns)) {
        expect(key).not.toBe("user_id")
      }
    }
  })

  it("join aliases resolve to catalog tables with valid predicates", () => {
    for (const [name, def] of Object.entries(queryTables)) {
      for (const [alias, join] of Object.entries(def.joins)) {
        const target = queryTables[join.target]
        expect(target, `${name} → ${alias}`).toBeDefined()
        expect(Object.keys(target.columns)).not.toContain("user_id")
      }
    }
  })
})

describe("parseQuery validation", () => {
  it("rejects with actionable errors", () => {
    expect(() => parseQuery("garbage")).toThrow(/expected a JSON object/)
    expect(() => parseQuery(null)).toThrow(/expected a JSON object/)
    expect(() => parseQuery({ table: "chat_messages" })).toThrow(
      /unknown table/
    )
    expect(() => parseQuery({ table: "users" })).toThrow(/unknown table/)
    expect(() => parseQuery({ table: "transactions", nope: 1 })).toThrow(
      /unknown field 'nope'/
    )
    expect(() =>
      parseQuery({ table: "transactions", select: ["amout_cents"] })
    ).toThrow(/unknown column 'amout_cents'/)
    expect(() =>
      parseQuery({ table: "transactions", select: ["user_id"] })
    ).toThrow(/unknown column 'user_id'/)
    expect(() =>
      parseQuery({
        table: "transactions",
        select: ["category.name"],
        where: [{ column: "kategorie.name", op: "eq", value: "x" }],
      })
    ).toThrow(/unknown join alias 'kategorie'/)
    expect(() =>
      parseQuery({
        table: "transactions",
        where: [{ column: "amount_cents", op: "=", value: 1 }],
      })
    ).toThrow(/op must be one of/)
    expect(() =>
      parseQuery({
        table: "transactions",
        where: [{ column: "amount_cents", op: "eq", value: "-1" }],
      })
    ).toThrow(/must be an integer/)
    expect(() =>
      parseQuery({
        table: "transactions",
        where: [{ column: "payee", op: "eq", value: 5 }],
      })
    ).toThrow(/must be a string/)
    expect(() =>
      parseQuery({
        table: "transactions",
        where: [{ column: "payee", op: "in", value: [] }],
      })
    ).toThrow(/non-empty array/)
    expect(() =>
      parseQuery({
        table: "transactions",
        where: [{ column: "payee", op: "isNull", value: "x" }],
      })
    ).toThrow(/takes no value/)
    expect(() => parseQuery({ table: "transactions", limit: 0 })).toThrow(
      /limit/
    )
    expect(() => parseQuery({ table: "transactions", limit: 1.5 })).toThrow(
      /limit/
    )
    // having without aggregate / unknown alias
    expect(() =>
      parseQuery({
        table: "transactions",
        having: [{ column: "summe", op: "gt", value: 0 }],
      })
    ).toThrow(/having requires/)
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "sum", column: "amount_cents", alias: "s" }],
        having: [{ column: "summe", op: "gt", value: 0 }],
      })
    ).toThrow(/must be an aggregate alias/)
  })

  it("rejects aggregate+select without matching groupBy", () => {
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "sum", column: "amount_cents" }],
        select: ["payee"],
      })
    ).toThrow(/without groupBy/)
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "sum", column: "amount_cents" }],
        groupBy: ["booking_month"],
        select: ["payee"],
      })
    ).toThrow(/must appear in groupBy/)
    expect(
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "sum", column: "amount_cents" }],
        groupBy: ["booking_month"],
        select: ["booking_month"],
      })
    ).toMatchObject({ groupBy: ["booking_month"] })
  })

  it("rejects groupBy without aggregate", () => {
    // bare-column grouping has undefined SQLite semantics; groups also
    // can't be counted meaningfully when the row limit cuts
    expect(() =>
      parseQuery({ table: "transactions", groupBy: ["booking_month"] })
    ).toThrow(/groupBy requires at least one aggregate/)
  })

  it("rejects an aggregate alias colliding with a groupBy output key", () => {
    // a joined group key compiles to "alias_col" — a duplicate label would
    // silently swallow one of the two values in the row object
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "count", column: "payee", alias: "category_name" }],
        groupBy: ["category.name"],
      })
    ).toThrow(/collides with a groupBy column name/)
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "count", column: "payee", alias: "booking_month" }],
        groupBy: ["booking_month"],
      })
    ).toThrow(/collides with a groupBy column name/)
  })

  it("rejects duplicate select output keys", () => {
    // different refs (FK + joined id) resolving to the same result column
    expect(() =>
      parseQuery({
        table: "transactions",
        select: ["account_id", "account.id"],
      })
    ).toThrow(/duplicate output column 'account_id'/)
    // literal duplicate refs now fail too, consistent with groupBy
    expect(() =>
      parseQuery({ table: "transactions", select: ["payee", "payee"] })
    ).toThrow(/duplicate output column 'payee'/)
  })

  it("rejects duplicate groupBy output keys", () => {
    // FK ref + joined ref resolve to the same SELECT label — the row
    // object would swallow one GROUP BY expression's value, and groups
    // split when the scoped join nulls (e.g. a foreign account_id)
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "count", column: "payee" }],
        groupBy: ["account_id", "account.id"],
      })
    ).toThrow(/duplicate groupBy output column 'account_id'/)
    // literal duplicate refs fail too, consistent with select
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "count", column: "payee" }],
        groupBy: ["payee", "payee"],
      })
    ).toThrow(/duplicate groupBy output column 'payee'/)
  })

  it("rejects an aggregate-mode orderBy ref outside groupBy", () => {
    // SQLite would silently pick an arbitrary row value per group
    expect(() =>
      parseQuery({
        table: "transactions",
        aggregate: [{ fn: "sum", column: "amount_cents" }],
        groupBy: ["booking_month"],
        orderBy: [{ column: "payee" }],
      })
    ).toThrow(/orderBy column 'payee' must appear in groupBy when aggregating/)
    // aliases and groupBy refs stay allowed
    const byGroup = parseQuery({
      table: "transactions",
      aggregate: [{ fn: "sum", column: "amount_cents", alias: "s" }],
      groupBy: ["booking_month"],
      orderBy: [{ column: "booking_month" }],
    })
    expect(byGroup.orderBy).toEqual([
      { column: "booking_month", direction: "asc" },
    ])
    // row queries are unaffected
    expect(
      parseQuery({ table: "transactions", orderBy: [{ column: "payee" }] })
        .orderBy
    ).toEqual([{ column: "payee", direction: "asc" }])
  })

  it("clamps the limit, defaults to 20, resolves aggregate aliases", () => {
    expect(parseQuery({ table: "transactions", limit: 500 }).limit).toBe(100)
    expect(parseQuery({ table: "transactions" }).limit).toBe(20)
    const parsed = parseQuery({
      table: "transactions",
      aggregate: [{ fn: "count", column: "payee" }],
    })
    expect(parsed.aggregate[0].alias).toBe("count_payee")
    expect(
      parseQuery({ table: "transactions", aggregate: [{ fn: "count" }] })
        .aggregate[0].alias
    ).toBe("count")
  })
})

describe("query_data — row queries", () => {
  it("filters, orders and selects", async () => {
    seedTx({
      userId: uid1,
      amountCents: -5000,
      bookingDate: "2026-01-05",
      payee: "Aldi",
    })
    seedTx({
      userId: uid1,
      amountCents: -30000,
      bookingDate: "2026-03-02",
      payee: "Bahn",
    })
    seedTx({
      userId: uid1,
      amountCents: -10,
      bookingDate: "2025-12-31",
      payee: "Alt",
    })

    const r = await run({
      table: "transactions",
      select: ["booking_date", "payee", "amount_cents"],
      where: [
        { column: "booking_date", op: "gte", value: "2026-01-01" },
        { column: "amount_cents", op: "lt", value: 0 },
      ],
      orderBy: [{ column: "booking_date", direction: "desc" }],
    })
    expect(r.columns).toEqual(["booking_date", "payee", "amount_cents"])
    expect(r.rowCount).toBe(2)
    expect(r.rows).toEqual([
      { booking_date: "2026-03-02", payee: "Bahn", amount_cents: -30000 },
      { booking_date: "2026-01-05", payee: "Aldi", amount_cents: -5000 },
    ])
    expect(r.limited).toBeUndefined()
    expect(r.totalMatching).toBeUndefined()
  })

  it("defaults to all base columns when select is omitted", async () => {
    seedTx({ userId: uid1, amountCents: -1, bookingDate: "2026-01-01" })
    const r = await run({ table: "transactions" })
    expect(r.columns).toContain("booking_date")
    expect(r.columns).toContain("amount_cents")
    expect(r.columns).not.toContain("user_id")
    expect(r.rowCount).toBe(1)
  })

  it("always scopes to the asking user — other users' rows never leak", async () => {
    seedTx({ userId: uid1, amountCents: -50, bookingDate: "2026-01-01" })
    seedTx({ userId: uid2, amountCents: -9999, bookingDate: "2026-01-01" })
    const r1 = await run({ table: "transactions", select: ["amount_cents"] })
    const r2 = await run(
      { table: "transactions", select: ["amount_cents"] },
      uid2
    )
    expect(r1.rows).toEqual([{ amount_cents: -50 }])
    expect(r2.rows).toEqual([{ amount_cents: -9999 }])
  })

  it("joins with alias.column refs and keeps NULL joins for uncategorized rows", async () => {
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -700,
      bookingDate: "2026-02-01",
    })
    seedTx({ userId: uid1, amountCents: -900, bookingDate: "2026-02-02" })

    const r = await run({
      table: "transactions",
      select: ["amount_cents", "category.name"],
      where: [{ column: "category.name", op: "eq", value: "Lebensmittel" }],
    })
    // the WHERE on the joined column excludes the uncategorized row
    expect(r.rows).toEqual([
      { amount_cents: -700, category_name: "Lebensmittel" },
    ])
  })

  it("emits the join when it is referenced only in orderBy (regression)", async () => {
    // Regression: join chunks used to materialize before order/group refs
    // resolved, so a join introduced only by orderBy produced
    // "no such column: categories.name" instead of a result.
    seedTx({
      userId: uid1,
      categoryId: cat1, // Lebensmittel
      amountCents: -700,
      bookingDate: "2026-02-01",
    })
    seedTx({
      userId: uid1,
      categoryId: cat2, // Reisen
      amountCents: -900,
      bookingDate: "2026-02-02",
    })
    const r = await run({
      table: "transactions",
      select: ["booking_date"],
      orderBy: [{ column: "category.name", direction: "desc" }],
    })
    expect(r.rows).toEqual([
      { booking_date: "2026-02-02" }, // Reisen sorts after Lebensmittel
      { booking_date: "2026-02-01" },
    ])
  })

  it("keeps rows with NULL join values when no joined filter applies", async () => {
    seedTx({
      userId: uid1,
      categoryId: cat2,
      amountCents: -1,
      bookingDate: "2026-02-01",
    })
    seedTx({ userId: uid1, amountCents: -2, bookingDate: "2026-02-02" })
    const r = await run({
      table: "transactions",
      select: ["amount_cents", "category.name"],
      orderBy: [{ column: "amount_cents" }],
    })
    expect(r.rows).toEqual([
      { amount_cents: -2, category_name: null },
      { amount_cents: -1, category_name: "Reisen" },
    ])
  })

  it("scopes joined tables to the user: another user's category never appears", async () => {
    // a category belonging to uid2 whose id is referenced by uid1's
    // transaction would leak via the join — user scoping in the ON clause
    // nulls it instead.
    const foreignCat = db
      .insert(categories)
      .values({
        userId: uid2,
        name: "Fremd",
        nameKey: "fremd",
        language: "de",
      })
      .returning()
      .get().id
    db.insert(transactions)
      .values({
        id: `tx-${crypto.randomUUID()}`,
        userId: uid1,
        accountId: accountIdFor(uid1),
        bookingDate: "2026-01-01",
        status: "Gebucht",
        payer: "P",
        payee: "Q",
        type: "Ausgang",
        amountCents: -500,
        sourceHash: `hash-${crypto.randomUUID()}`,
        labelStatus: "labeled",
        categoryId: foreignCat,
      })
      .run()

    const r = await run({
      table: "transactions",
      select: ["amount_cents", "category.name"],
    })
    expect(r.rows).toEqual([{ amount_cents: -500, category_name: null }])
  })

  it("supports whereAny OR groups", async () => {
    seedTx({
      userId: uid1,
      amountCents: -100,
      bookingDate: "2026-01-01",
      payee: "A",
    })
    seedTx({
      userId: uid1,
      amountCents: -200,
      bookingDate: "2026-01-02",
      payee: "B",
    })
    seedTx({
      userId: uid1,
      amountCents: -300,
      bookingDate: "2026-01-03",
      payee: "C",
    })
    const r = await run({
      table: "transactions",
      select: ["payee"],
      where: [{ column: "amount_cents", op: "lt", value: 0 }],
      whereAny: [
        { column: "payee", op: "eq", value: "A" },
        { column: "payee", op: "eq", value: "B" },
      ],
    })
    expect(r.rows.map((row) => row.payee).sort()).toEqual(["A", "B"])
  })

  it("contains escapes LIKE wildcards in the value", async () => {
    seedTx({
      userId: uid1,
      amountCents: -1,
      bookingDate: "2026-01-01",
      payee: "A 50% B",
    })
    seedTx({
      userId: uid1,
      amountCents: -2,
      bookingDate: "2026-01-01",
      payee: "A 50XB",
    })
    seedTx({
      userId: uid1,
      amountCents: -3,
      bookingDate: "2026-01-01",
      payee: "a_b",
    })
    seedTx({
      userId: uid1,
      amountCents: -4,
      bookingDate: "2026-01-01",
      payee: "axb",
    })

    const pct = await run({
      table: "transactions",
      select: ["payee"],
      where: [{ column: "payee", op: "contains", value: "50%" }],
    })
    expect(pct.rows).toEqual([{ payee: "A 50% B" }])
    const under = await run({
      table: "transactions",
      select: ["payee"],
      where: [{ column: "payee", op: "contains", value: "_" }],
    })
    expect(under.rows).toEqual([{ payee: "a_b" }])
  })

  it("like supports model-supplied wildcards, in filters on lists", async () => {
    seedTx({
      userId: uid1,
      amountCents: -1,
      bookingDate: "2026-01-01",
      payee: "Aldi Süd",
    })
    seedTx({
      userId: uid1,
      amountCents: -2,
      bookingDate: "2026-01-02",
      payee: "Lidl",
    })
    const like = await run({
      table: "transactions",
      select: ["payee"],
      where: [{ column: "payee", op: "like", value: "Aldi%" }],
    })
    expect(like.rows).toEqual([{ payee: "Aldi Süd" }])
    for (const amount of [-5, -15, -25]) {
      seedTx({ userId: uid1, amountCents: amount, bookingDate: "2026-01-03" })
    }
    const r = await run({
      table: "transactions",
      select: ["amount_cents"],
      where: [{ column: "amount_cents", op: "in", value: [-5, -25] }],
      orderBy: [{ column: "amount_cents" }],
    })
    expect(r.rows).toEqual([{ amount_cents: -25 }, { amount_cents: -5 }])
  })

  it("isNull/notNull work without a value", async () => {
    seedTx({
      userId: uid1,
      amountCents: -1,
      bookingDate: "2026-01-01",
      purpose: undefined,
    })
    seedTx({
      userId: uid1,
      amountCents: -2,
      bookingDate: "2026-01-02",
      purpose: "hi",
    })
    const r = await run({
      table: "transactions",
      select: ["amount_cents"],
      where: [{ column: "purpose", op: "isNull" }],
    })
    expect(r.rows).toEqual([{ amount_cents: -1 }])
  })

  it("reports limited + totalMatching when the row limit bites", async () => {
    for (let i = 0; i < 150; i++) {
      seedTx({ userId: uid1, amountCents: -i - 1, bookingDate: "2026-01-01" })
    }
    const r = await run({ table: "transactions", select: ["amount_cents"] })
    expect(r.rowCount).toBe(20)
    expect(r.limit).toBe(20)
    expect(r.limited).toBe(true)
    expect(r.totalMatching).toBe(150)

    const capped = await run({
      table: "transactions",
      select: ["amount_cents"],
      limit: 5,
    })
    expect(capped.rowCount).toBe(5)
    expect(capped.totalMatching).toBe(150)
  })

  it("clamps an over-limit ask to 100 instead of failing", async () => {
    for (let i = 0; i < 120; i++) {
      seedTx({ userId: uid1, amountCents: -i - 1, bookingDate: "2026-01-01" })
    }
    const r = await run({ table: "transactions", limit: 500 })
    expect(r.limit).toBe(100)
    expect(r.rowCount).toBe(100)
    expect(r.limited).toBe(true)
    expect(r.totalMatching).toBe(120)
  })

  it("truncates long string cells", async () => {
    seedTx({
      userId: uid1,
      amountCents: -1,
      bookingDate: "2026-01-01",
      purpose: "x".repeat(600),
    })
    const r = await run({
      table: "transactions",
      select: ["purpose"],
    })
    expect((r.rows[0].purpose as string).length).toBe(201)
    expect((r.rows[0].purpose as string).endsWith("…")).toBe(true)
  })
})

describe("query_data — aggregates", () => {
  it("sums per booking_month with having and alias ordering", async () => {
    seedTx({ userId: uid1, amountCents: -1000, bookingDate: "2026-01-15" })
    seedTx({ userId: uid1, amountCents: -500, bookingDate: "2026-01-25" })
    seedTx({ userId: uid1, amountCents: -3000, bookingDate: "2026-02-10" })
    seedTx({ userId: uid2, amountCents: -99999, bookingDate: "2026-01-10" })

    const r = await run({
      table: "transactions",
      aggregate: [{ fn: "sum", column: "amount_cents", alias: "summe_cents" }],
      groupBy: ["booking_month"],
      orderBy: [{ column: "summe_cents", direction: "asc" }],
    })
    expect(r.rows).toEqual([
      { booking_month: "2026-02", summe_cents: -3000 },
      { booking_month: "2026-01", summe_cents: -1500 },
    ])
  })

  it("supports count, grand totals without groupBy, and having", async () => {
    seedTx({
      userId: uid1,
      amountCents: -1000,
      bookingDate: "2026-01-01",
      payee: "A",
    })
    seedTx({
      userId: uid1,
      amountCents: -1000,
      bookingDate: "2026-01-02",
      payee: "A",
    })
    seedTx({
      userId: uid1,
      amountCents: 400,
      bookingDate: "2026-01-03",
      payee: "A",
    })

    const r = await run({
      table: "transactions",
      aggregate: [
        { fn: "count" },
        { fn: "sum", column: "amount_cents", alias: "s" },
      ],
    })
    expect(r.rows).toEqual([{ count: 3, s: -1600 }])

    const filtered = await run({
      table: "transactions",
      aggregate: [{ fn: "sum", column: "amount_cents", alias: "s" }],
      groupBy: ["booking_month"],
      having: [{ column: "s", op: "lt", value: -2000 }],
    })
    expect(filtered.rows).toEqual([])
  })

  it("having lte includes the boundary value (op not silently widened to lt)", async () => {
    seedTx({ userId: uid1, amountCents: -100, bookingDate: "2026-01-10" })
    seedTx({ userId: uid1, amountCents: -200, bookingDate: "2026-02-10" })
    const r = await run({
      table: "transactions",
      aggregate: [{ fn: "sum", column: "amount_cents", alias: "s" }],
      groupBy: ["booking_month"],
      having: [{ column: "s", op: "lte", value: -100 }],
      orderBy: [{ column: "s" }],
    })
    // both months (sums exactly -100 and -200) stay; a compiled "lt" would
    // have dropped the boundary-exact group. ASC on negatives = more
    // negative first.
    expect(r.rows).toEqual([
      { booking_month: "2026-02", s: -200 },
      { booking_month: "2026-01", s: -100 },
    ])
    const strict = await run({
      table: "transactions",
      aggregate: [{ fn: "sum", column: "amount_cents", alias: "s" }],
      groupBy: ["booking_month"],
      having: [{ column: "s", op: "lt", value: -100 }],
      orderBy: [{ column: "s" }],
    })
    expect(strict.rows).toEqual([{ booking_month: "2026-02", s: -200 }])
  })

  it("returns a coalesced 0 sum for an empty match set", async () => {
    const r = await run({
      table: "transactions",
      aggregate: [{ fn: "sum", column: "amount_cents", alias: "s" }],
    })
    expect(r.rows).toEqual([{ s: 0 }])
  })

  it("groups and filters by derived columns", async () => {
    seedTx({ userId: uid1, amountCents: -100, bookingDate: "2026-03-15" })
    seedTx({ userId: uid1, amountCents: -200, bookingDate: "2025-03-15" })
    const r = await run({
      table: "transactions",
      select: ["booking_year"],
      where: [{ column: "booking_month", op: "eq", value: "2026-03" }],
    })
    expect(r.rows).toEqual([{ booking_year: "2026" }])
  })
})

describe("parse errors surface through the tool for self-correction", () => {
  it("invalid args produce error messages naming the problem", async () => {
    expect(await failArgs("garbage")).toMatch(/expected a JSON object/)
    expect(await failArgs({ table: "transactions", select: ["nope"] })).toMatch(
      /unknown column 'nope'/
    )
    expect(await failArgs(null)).toMatch(/expected a JSON object/)
  })
})

describe("queryDataPromptDoc", () => {
  it("lists every catalog table, its columns and the ops, and no user_id", () => {
    const doc = queryDataPromptDoc()
    for (const name of Object.keys(queryTables)) {
      expect(doc).toContain(`- ${name}:`)
    }
    for (const key of Object.keys(queryTables.transactions.columns)) {
      expect(doc).toContain(key)
    }
    expect(doc).toContain("category.name")
    expect(doc).toContain("booking_month")
    expect(doc).not.toContain("user_id")
    // every op spelled in the doc must be one the parser actually accepts
    // (the generated examples must not teach an op like ">=" that fails)
    const ops = [...doc.matchAll(/"op":"([a-zA-Z]+)"/g)]
    expect(ops.length).toBeGreaterThan(0)
    for (const match of ops) {
      expect(QUERY_OPS).toContain(match[1])
    }
  })
})

describe("readonly connection refuses writes", () => {
  it("createReadOnlyDb cannot insert/update on a real file DB", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "geldlage-ro-"))
    try {
      const file = path.join(dir, "ro.db")
      const writeDb = drizzle(new Database(file), { schema })
      // create the schema through the write handle
      createSchemaSqlite(writeDb as Db)
      const ro = createReadOnlyDb(file)
      expect(() =>
        ro
          .insert(transactions)
          .values({
            id: "tx-ro",
            userId: 1,
            accountId: 1,
            bookingDate: "2026-01-01",
            payer: "P",
            payee: "Q",
            type: "Ausgang",
            amountCents: -1,
            sourceHash: "h",
          })
          .run()
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
