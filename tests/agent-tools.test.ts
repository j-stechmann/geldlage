import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import { accounts, categories, transactions } from "@/lib/db/schema"
import {
  agentTools,
  periodEndDate,
  periodStartDate,
  toolByName,
  toolsForRequest,
} from "@/lib/agent/tools"
import type {
  CalculatorResult,
  CategoryTotalsPeriod,
  CategoryTotalsStatus,
} from "@/lib/agent/tools"
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
  /** Omit/null for uncategorized rows (label_status pending/failed). */
  categoryId?: number | null
  amountCents: number
  bookingDate: string
  status?: string
}): void {
  db.insert(transactions)
    .values({
      id: `tx-${crypto.randomUUID()}`,
      userId: opts.userId,
      accountId: accountIdFor(opts.userId),
      bookingDate: opts.bookingDate,
      status: opts.status ?? "Gebucht",
      payer: "P",
      payee: "Q",
      type: opts.amountCents < 0 ? "Ausgang" : "Eingang",
      amountCents: opts.amountCents,
      sourceHash: `hash-${crypto.randomUUID()}`,
      labelStatus: "labeled",
      categoryId: opts.categoryId ?? null,
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

/** Last day of the current month, ISO (vorgemerkt rows are post-dated). */
function lastDayOfThisMonth(): string {
  const now = new Date()
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`
}

/** First day of the next month, ISO (next month's business stays out). */
function firstOfNextMonth(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + 1)
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
    expect(wire).toHaveLength(3)
    expect(wire[0].type).toBe("function")
    expect(wire[0].function.name).toBe("get_category_totals")
    expect(wire[0].function.description.length).toBeGreaterThan(10)
    expect(wire[0].function.parameters).toMatchObject({
      type: "object",
      required: ["period"],
      properties: {
        period: {
          type: "string",
          enum: ["this_month", "last_month", "last_90_days"],
        },
        status: { type: "string", enum: ["Gebucht", "Nicht gebucht", "both"] },
      },
    })
    expect(wire[1].function.name).toBe("query_data")
    expect(wire[1].function.parameters).toMatchObject({
      type: "object",
      required: ["table"],
      additionalProperties: false,
    })
    expect(wire[2].function.name).toBe("calculator")
    expect(wire[2].function.parameters).toMatchObject({
      type: "object",
      required: ["expression"],
      additionalProperties: false,
      properties: {
        expression: { type: "string" },
      },
    })
  })

  it("resolves by name and rejects unknown tools", () => {
    expect(toolByName("get_category_totals")?.name).toBe("get_category_totals")
    expect(toolByName("query_data")?.name).toBe("query_data")
    expect(toolByName("calculator")?.name).toBe("calculator")
    expect(toolByName("nope")).toBeUndefined()
    expect(agentTools).toHaveLength(3)
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

describe("periodEndDate", () => {
  it("runs this_month through the month's end (post-dated rows count)", () => {
    // Regression: the window used to end "tomorrow", silently dropping
    // vorgemerkte rows with future booking dates inside the month.
    expect(periodEndDate("this_month", new Date(2026, 9, 16))).toBe(
      "2026-11-01"
    )
  })

  it("runs last_90_days through the current month's end too", () => {
    expect(periodEndDate("last_90_days", new Date(2026, 9, 16))).toBe(
      "2026-11-01"
    )
  })

  it("closes last_month at the 1st of the current month", () => {
    expect(periodEndDate("last_month", new Date(2026, 9, 16))).toBe(
      "2026-10-01"
    )
  })

  it("rolls the year over December", () => {
    expect(periodEndDate("this_month", new Date(2026, 11, 24))).toBe(
      "2027-01-01"
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

  it("counts uncategorized rows in totalsCents under an Ohne Kategorie bucket", async () => {
    const tool = toolByName("get_category_totals")!
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -3000,
      bookingDate: firstOfThisMonth(),
    })
    // uncategorized (label run still pending/failed — the normal state of
    // a fresh import): must not vanish from the totals (analytics parity)
    seedTx({
      userId: uid1,
      amountCents: -7000,
      bookingDate: dayFromToday(0),
    })
    seedTx({
      userId: uid1,
      amountCents: 500,
      bookingDate: dayFromToday(0),
    })

    const r = (await tool.execute({ period: "this_month" }, { uid: uid1 })) as {
      categories: Array<{
        category: string
        inflowCents: number
        outflowCents: number
        count: number
      }>
      totalsCents: { inflow: number; outflow: number }
    }
    expect(r.totalsCents).toEqual({ inflow: 500, outflow: -10000 })
    expect(r.categories).toContainEqual({
      category: "Ohne Kategorie",
      inflowCents: 500,
      outflowCents: -7000,
      count: 2,
    })
    expect(r.categories).toContainEqual({
      category: "Lebensmittel",
      inflowCents: 0,
      outflowCents: -3000,
      count: 1,
    })
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

  it("defaults to Gebucht and excludes Nicht gebucht rows (matches the UI)", async () => {
    const tool = toolByName("get_category_totals")!
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -1000,
      bookingDate: dayFromToday(-1),
      status: "Gebucht",
    })
    // pending row in-window with a category: dashboards don't count it by
    // default (parseFilters status = "Gebucht"), the tool must match
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -40000,
      bookingDate: dayFromToday(-1),
      status: "Nicht gebucht",
    })

    const def = (await tool.execute(
      { period: "this_month" },
      { uid: uid1 }
    )) as { status: string; totalsCents: { outflow: number } }
    expect(def.status).toBe("Gebucht")
    expect(def.totalsCents.outflow).toBe(-1000)
  })

  it("filters Nicht gebucht only", async () => {
    const tool = toolByName("get_category_totals")!
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -1000,
      bookingDate: dayFromToday(-1),
      status: "Gebucht",
    })
    seedTx({
      userId: uid1,
      categoryId: cat2,
      amountCents: -40000,
      bookingDate: dayFromToday(-1),
      status: "Nicht gebucht",
    })

    const r = (await tool.execute(
      { period: "this_month", status: "Nicht gebucht" },
      { uid: uid1 }
    )) as {
      status: string
      categories: Array<{ category: string; outflowCents: number }>
    }
    expect(r.status).toBe("Nicht gebucht")
    expect(r.categories).toHaveLength(1)
    expect(r.categories[0].category).toBe("Reisen")
    expect(r.categories[0].outflowCents).toBe(-40000)
  })

  it("status both sums booked and pending rows together", async () => {
    const tool = toolByName("get_category_totals")!
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -1000,
      bookingDate: dayFromToday(-1),
      status: "Gebucht",
    })
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -40000,
      bookingDate: dayFromToday(-1),
      status: "Nicht gebucht",
    })

    const r = (await tool.execute(
      { period: "this_month", status: "both" },
      { uid: uid1 }
    )) as { status: string; totalsCents: { outflow: number }; count?: never }
    const withCount = r as typeof r & {
      categories: Array<{ count: number }>
    }
    expect(r.status).toBe("both")
    expect(r.totalsCents.outflow).toBe(-41000)
    expect(withCount.categories[0].count).toBe(2)
  })

  it("counts post-dated vorgemerkt rows within the month, excludes next month's", async () => {
    const tool = toolByName("get_category_totals")!
    // Bank CSVs reserve upcoming debits as "Nicht gebucht" with a
    // FUTURE booking date: a row dated later this month must count
    // for this_month + Nicht gebucht (regression: the old window ended
    // "tomorrow" and dropped it). A row already dated next month is
    // that month's business and must stay out.
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -6000,
      bookingDate: lastDayOfThisMonth(),
      status: "Nicht gebucht",
    })
    seedTx({
      userId: uid1,
      categoryId: cat1,
      amountCents: -99999,
      bookingDate: firstOfNextMonth(),
      status: "Nicht gebucht",
    })

    const r = (await tool.execute(
      { period: "this_month", status: "Nicht gebucht" },
      { uid: uid1 }
    )) as { totalsCents: { outflow: number } }
    expect(r.totalsCents.outflow).toBe(-6000)
  })

  it("accepts every documented status value", async () => {
    const tool = toolByName("get_category_totals")!
    const statuses: CategoryTotalsStatus[] = [
      "Gebucht",
      "Nicht gebucht",
      "both",
    ]
    for (const status of statuses) {
      const result = (await tool.execute(
        { period: "this_month", status },
        { uid: uid1 }
      )) as { status: string }
      expect(result.status).toBe(status)
    }
  })

  it("rejects invalid status values", async () => {
    const tool = toolByName("get_category_totals")!
    await expect(
      tool.execute({ period: "this_month", status: "pending" }, { uid: uid1 })
    ).rejects.toThrow(/invalid args/)
    await expect(
      tool.execute({ period: "this_month", status: 1 }, { uid: uid1 })
    ).rejects.toThrow(/invalid args/)
  })
})

describe("calculator", () => {
  /** Cast helper matching the file's existing per-test result shapes. */
  async function run(expression: unknown): Promise<CalculatorResult> {
    const tool = toolByName("calculator")!
    return (await tool.execute(
      { expression },
      { uid: uid1 }
    )) as CalculatorResult
  }

  it("evaluates a plain sum", async () => {
    const r = await run("12890 + 3400")
    expect(r.expression).toBe("12890 + 3400")
    expect(r.result).toBe(16290)
  })

  it("honours operator precedence and parentheses", async () => {
    expect((await run("2 + 3 * 4")).result).toBe(14)
    expect((await run("(2 + 3) * 4")).result).toBe(20)
    expect((await run("-5 ^ 2")).result).toBe(-25)
  })

  it("handles decimal fractions (cent→euro conversion)", async () => {
    expect((await run("(12890 + 3400) / 100")).result).toBe(162.9)
  })

  it("treats % as division remainder, not a percent sign", async () => {
    // expr-eval's % is modulo: a model reading it as "percent of" would get
    // a plausible but wrong "verified" result, so the semantics are pinned
    // here and spelled out in the tool description.
    expect((await run("150 % 40")).result).toBe(30)
    expect((await run("200 % 50")).result).toBe(0)
  })

  it("rejects invalid args", async () => {
    const tool = toolByName("calculator")!
    await expect(
      tool.execute({ expression: 42 }, { uid: uid1 })
    ).rejects.toThrow(/invalid args/)
    await expect(tool.execute("1 + 1", { uid: uid1 })).rejects.toThrow(
      /invalid args/
    )
    await expect(
      tool.execute({ expression: "  " }, { uid: uid1 })
    ).rejects.toThrow(/invalid args/)
    await expect(tool.execute({}, { uid: uid1 })).rejects.toThrow(
      /invalid args/
    )
  })

  it("rejects unparseable expressions", async () => {
    await expect(run("1 +")).rejects.toThrow(/invalid expression/)
    await expect(run("foo(1)")).rejects.toThrow(/invalid expression/)
    await expect(run("x")).rejects.toThrow(/invalid expression/)
  })

  it("rejects expr-eval's non-arithmetic grammar", async () => {
    // The parser instance is narrowed to pure arithmetic: built-in functions
    // (including random()), constants, comparisons, string concatenation and
    // array indexing must never reach the model as a "verified" number.
    await expect(run("sqrt(16290)")).rejects.toThrow(/invalid expression/)
    await expect(run("random()")).rejects.toThrow(/invalid expression/)
    await expect(run("min(3, 7)")).rejects.toThrow(/invalid expression/)
    await expect(run("PI")).rejects.toThrow(/invalid expression/)
    await expect(run("true")).rejects.toThrow(/invalid expression/)
    await expect(run("1 > 0")).rejects.toThrow(/invalid expression/)
    await expect(run('"5" || "5"')).rejects.toThrow(/invalid expression/)
    await expect(run("[1, 2][0]")).rejects.toThrow(/invalid expression/)
    await expect(run("1 ? 2 : 3")).rejects.toThrow(/invalid expression/)
  })

  it("rejects non-finite results (division by zero)", async () => {
    // expr-eval follows JS arithmetic, so 1/0 is Infinity: the tool must
    // not hand the model an "infinite" number and have it read it as real.
    await expect(run("1 / 0")).rejects.toThrow(/not a finite number/)
    await expect(run("0 / 0")).rejects.toThrow(/not a finite number/)
  })
})
