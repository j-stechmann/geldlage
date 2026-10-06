import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import { accounts, categories, transactions } from "@/lib/db/schema"
import {
  agentTools,
  periodStartDate,
  toolByName,
  toolsForRequest,
} from "@/lib/agent/tools"
import type { CategoryTotalsPeriod } from "@/lib/agent/tools"
import { seedUser, setupTestDb } from "./helpers"

let db: Db
let uid1: number
let uid2: number
let cat1: number
let cat2: number

/**
 * Seeds transactions relative to `now` the same way tools.ts computes the
 * period boundaries (periodStartDate + a `now` the tests control via the
 * system clock — tests are written relative to the real clock so the
 * windows line up exactly like production queries see them).
 */
function seedTx(opts: {
  userId: number
  categoryId: number
  amountCents: number
  bookingDate: string
}): void {
  db.insert(transactions)
    .values({
      id: `tx-${crypto.randomUUID()}`,
      userId: opts.userId,
      accountId: accountIdFor(opts.userId),
      bookingDate: opts.bookingDate,
      status: "Gebucht",
      payer: "P",
      payee: "Q",
      type: opts.amountCents < 0 ? "Ausgang" : "Eingang",
      amountCents: opts.amountCents,
      sourceHash: `hash-${crypto.randomUUID()}`,
      labelStatus: "labeled",
      categoryId: opts.categoryId,
    })
    .run()
}

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

/** ISO day N days from today (local), matching periodStartDate's clock. */
function dayFromToday(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** First day of the current month, ISO. */
function firstOfThisMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`
}

/** First day of the previous month, ISO. */
function firstOfLastMonth(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`
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

describe("toolsForRequest / toolByName", () => {
  it("maps the registry into the OpenAI wire format", () => {
    const wire = toolsForRequest()
    expect(wire).toHaveLength(1)
    expect(wire[0].type).toBe("function")
    expect(wire[0].function.name).toBe("get_category_totals")
    expect(wire[0].function.description.length).toBeGreaterThan(10)
    expect(wire[0].function.parameters).toMatchObject({
      type: "object",
      required: ["period"],
    })
  })

  it("resolves by name and rejects unknown tools", () => {
    expect(toolByName("get_category_totals")?.name).toBe("get_category_totals")
    expect(toolByName("nope")).toBeUndefined()
    expect(agentTools).toHaveLength(1)
  })
})

describe("periodStartDate", () => {
  it("starts this_month at the 1st", () => {
    const now = new Date(2026, 9, 6) // 2026-10-06
    expect(periodStartDate("this_month", now)).toBe("2026-10-01")
  })

  it("crosses the year boundary for last_month", () => {
    expect(periodStartDate("last_month", new Date(2026, 0, 15))).toBe(
      "2025-12-01"
    )
    expect(periodStartDate("last_month", new Date(2026, 9, 6))).toBe(
      "2026-09-01"
    )
  })

  it("rolls last_90_days back 90 calendar days", () => {
    expect(periodStartDate("last_90_days", new Date(2026, 9, 6))).toBe(
      "2026-07-08"
    )
  })

  it("handles the leap-day path", () => {
    expect(periodStartDate("last_month", new Date(2024, 2, 31))).toBe(
      "2024-02-01"
    )
  })
})

describe("get_category_totals", () => {
  it("folds per-category in/outflow buckets and totals for this_month", async () => {
    const tool = toolByName("get_category_totals")!
    // in-window: a negative (outflow) and a positive (inflow)
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -5000,
      bookingDate: dayFromToday(-2),
    })
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: 1000,
      bookingDate: firstOfThisMonth(),
    })
    seedTx({
      userId: uid1,
      categoryId: cat2,
      amountCents: -20000,
      bookingDate: dayFromToday(-1),
    })
    // before this_month → must not count (Jan 1 style guard: use last month's first)
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -99999,
      bookingDate: firstOfLastMonth(),
    })

    const result = (await tool.execute(
      { period: "this_month" },
      { uid: uid1 }
    )) as {
      period: string
      categories: Array<{
        category: string
        inflowCents: number
        outflowCents: number
        count: number
      }>
      totalsCents: { inflow: number; outflow: number }
    }

    expect(result.period).toBe("this_month")
    expect(result.totalsCents).toEqual({ inflow: 1000, outflow: -25000 })
    // largest |net| first: Reisen (-20000) before Lebensmittel (-4000)
    expect(result.categories[0].category).toBe("Reisen")
    expect(result.categories[0]).toEqual({
      category: "Reisen",
      inflowCents: 0,
      outflowCents: -20000,
      count: 1,
    })
    expect(result.categories[1]).toEqual({
      category: "Lebensmittel",
      inflowCents: 1000,
      outflowCents: -5000,
      count: 2,
    })
  })

  it("windows last_month by its calendar bounds", async () => {
    const tool = toolByName("get_category_totals")!
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -777,
      bookingDate: firstOfLastMonth(),
    })
    // outside: this-month and two-months-ago rows must not appear
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -1,
      bookingDate: firstOfThisMonth(),
    })
    const twoBack = new Date()
    twoBack.setDate(1)
    twoBack.setMonth(twoBack.getMonth() - 2)
    const twoBackIso = `${twoBack.getFullYear()}-${String(twoBack.getMonth() + 1).padStart(2, "0")}-01`
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -2,
      bookingDate: twoBackIso,
    })

    const result = (await tool.execute(
      { period: "last_month" },
      { uid: uid1 }
    )) as {
      categories: Array<{ outflowCents: number; count: number }>
    }
    expect(result.categories).toHaveLength(1)
    expect(result.categories[0].outflowCents).toBe(-777)
    expect(result.categories[0].count).toBe(1)
  })

  it("covers 90 days inclusive of older this-month rows", async () => {
    const tool = toolByName("get_category_totals")!
    const longAgo = periodStartDate("last_90_days", new Date())
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -42,
      bookingDate: longAgo,
    })
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -43,
      bookingDate: dayFromToday(-91),
    })

    const result = (await tool.execute(
      { period: "last_90_days" },
      { uid: uid1 }
    )) as {
      categories: Array<{ count: number; outflowCents: number }>
    }
    expect(result.categories[0].count).toBe(1)
    expect(result.categories[0].outflowCents).toBe(-42)
  })

  it("isolates users: other users' transactions never leak", async () => {
    const tool = toolByName("get_category_totals")!
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -50,
      bookingDate: dayFromToday(-1),
    })
    seedTx({
      userId: uid2,
      categoryId: cat1,
      amountCents: -9999,
      bookingDate: dayFromToday(-1),
    })

    const r1 = (await tool.execute(
      { period: "this_month" },
      { uid: uid1 }
    )) as {
      totalsCents: { outflow: number }
    }
    const r2 = (await tool.execute(
      { period: "this_month" },
      { uid: uid2 }
    )) as {
      totalsCents: { outflow: number }
    }
    expect(r1.totalsCents.outflow).toBe(-50)
    expect(r2.totalsCents.outflow).toBe(-9999)
  })

  it("rejects invalid args", async () => {
    const tool = toolByName("get_category_totals")!
    await expect(
      tool.execute({ period: "forever" }, { uid: uid1 })
    ).rejects.toThrow(/invalid args/)
    await expect(tool.execute("garbage", { uid: uid1 })).rejects.toThrow(
      /invalid args/
    )
    await expect(tool.execute({}, { uid: uid1 })).rejects.toThrow(
      /invalid args/
    )
  })

  it("accepts every documented period value", async () => {
    const tool = toolByName("get_category_totals")!
    const periods: CategoryTotalsPeriod[] = [
      "this_month",
      "last_month",
      "last_90_days",
    ]
    for (const period of periods) {
      const result = (await tool.execute({ period }, { uid: uid1 })) as {
        period: string
      }
      expect(result.period).toBe(period)
    }
  })
})
