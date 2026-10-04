import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql, and, eq, gte, lte } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { parseDkbCsv } from "@/lib/csv/parser"
import { computeDedupe } from "@/lib/db/dedupe"
import { seedUser } from "./helpers"
import { computeAnalytics } from "@/lib/analytics/engine"
import { parseFilters } from "@/lib/analytics/queries"
import {
  transactions,
  accounts,
  importBatches,
  categories,
} from "@/lib/db/schema"

interface Manifest {
  account: { iban: string; name: string }
  snapshot: { date: string; amountCents: number }
  rowCount: number
  pendingCount: number
  zeroAmountCount: number
  expected: {
    transactionCount: number
    currentBalanceCents: number
    avgMonthlyIncomeCents: number
    avgMonthlyExpensesCents: number
    savingsRate: number
    monthsCounted: number
    monthlyCashflow: Array<{
      month: string
      incomeCents: number
      expensesCents: number
    }>
    topCategories: Array<{ name: string; totalCents: number }>
  }
}

const fixtureDir = join(__dirname, "fixtures")
const csv = readFileSync(join(fixtureDir, "fixture.csv"), "utf8")
const manifest: Manifest = JSON.parse(
  readFileSync(join(fixtureDir, "fixture-manifest.json"), "utf8")
)

let db: Db

/**
 * Import the fixture through the REAL pipeline pieces (parser → dedupe →
 * DB insert) against an in-memory SQLite, without the labeller.
 */
let userId: number

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

  const batch = db
    .insert(importBatches)
    .values({
      userId,
      id: "fixture-batch",
      fileName: "fixture.csv",
      accountId: account.id,
      status: "importing",
      snapshotDate: parsed.snapshotDate,
      snapshotAmountCents: parsed.snapshotAmountCents,
      rowsTotal: parsed.rows.length,
    })
    .returning()
    .get()

  const dedupe = computeDedupe(
    parsed.accountIban,
    userId,
    account.id,
    batch.id,
    parsed.rows,
    new Map()
  )
  expect(dedupe.duplicateCount).toBe(0)
  expect(dedupe.toInsert.length).toBe(parsed.rows.length)

  db.transaction((tx) => {
    for (const row of dedupe.toInsert) {
      tx.insert(transactions).values(row).run()
    }
  })

  // post-insert invariant: imported + duplicates === parsed rows
  const importedCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .get()?.count ?? 0
  expect(importedCount).toBe(parsed.rows.length)

  // simulate the labeller: one category per counterparty (the fixture
  // manifest's topCategories are keyed on counterparty for this reason)
  const all = db.select().from(transactions).all()
  const catIdByCounterparty = new Map<string, number>()
  for (const t of all) {
    const label = t.type === "Ausgang" ? (t.payee ?? "") : (t.payer ?? "")
    if (!label || t.categoryId !== null) continue
    let catId = catIdByCounterparty.get(label)
    if (!catId) {
      const inserted = db
        .insert(categories)
        .values({
          userId,
          name: label,
          nameKey: label.toLowerCase(),
          language: "de",
        })
        .onConflictDoNothing()
        .returning()
        .get()
      const cat =
        inserted ??
        db
          .select()
          .from(categories)
          .where(eq(categories.nameKey, label.toLowerCase()))
          .get()
      catId = cat.id
      catIdByCounterparty.set(label, catId)
    }
    db.update(transactions)
      .set({ categoryId: catId, labelStatus: "labeled" })
      .where(eq(transactions.id, t.id))
      .run()
  }
})

describe("fixture end-to-end correctness", () => {
  it("parses all rows, account and snapshot", () => {
    const parsed = parseDkbCsv(csv)
    expect(parsed.accountIban).toBe(manifest.account.iban)
    expect(parsed.snapshotDate).toBe(manifest.snapshot.date)
    expect(parsed.snapshotAmountCents).toBe(manifest.snapshot.amountCents)
    expect(parsed.rows).toHaveLength(manifest.rowCount)
  })

  it("stores every row including pending and zero-amount", () => {
    const all = db.select().from(transactions).all()
    expect(all).toHaveLength(manifest.rowCount)
    const pending = all.filter((r) => r.status === "Nicht gebucht")
    expect(pending).toHaveLength(manifest.pendingCount)
    const zero = all.filter((r) => r.amountCents === 0)
    expect(zero).toHaveLength(manifest.zeroAmountCount)
  })

  it("preserves identical same-day transactions (coffee pair × 24 months)", () => {
    const coffees = db
      .select()
      .from(transactions)
      .where(eq(transactions.purpose, "Kaffee"))
      .all()
    expect(coffees).toHaveLength(48) // 2 per month × 24
    // each month contributes one occurrence 0 and one occurrence 1
    const counts = { 0: 0, 1: 0 } as Record<string, number>
    for (const c of coffees) {
      counts[String(c.occurrenceIndex)] =
        (counts[String(c.occurrenceIndex)] ?? 0) + 1
    }
    expect(counts["0"]).toBe(24)
    expect(counts["1"]).toBe(24)
  })

  it("computes current balance to the cent (latest snapshot + subsequent)", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, userId, "2026-08-28")
    expect(result.kpis.currentBalanceCents).toBe(
      manifest.expected.currentBalanceCents
    )
    expect(result.kpis.balanceWithoutSnapshot).toBe(false)
  })

  it("matches hand-computed KPIs exactly", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, userId, "2026-08-28")
    expect(result.kpis.transactionCount).toBe(
      manifest.expected.transactionCount
    )
    expect(result.kpis.avgMonthlyIncomeCents).toBe(
      manifest.expected.avgMonthlyIncomeCents
    )
    expect(result.kpis.avgMonthlyExpensesCents).toBe(
      manifest.expected.avgMonthlyExpensesCents
    )
    expect(result.kpis.savingsRate).toBeCloseTo(
      manifest.expected.savingsRate,
      10
    )
    expect(result.kpis.monthsCounted).toBe(manifest.expected.monthsCounted)
  })

  it("matches every month's income/expenses to the cent", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, userId, "2026-08-28")
    expect(result.monthlyCashflow).toHaveLength(
      manifest.expected.monthlyCashflow.length
    )
    for (const expected of manifest.expected.monthlyCashflow) {
      const actual = result.monthlyCashflow.find(
        (m) => m.month === expected.month
      )
      expect(actual, `month ${expected.month}`).toBeDefined()
      expect(actual!.incomeCents).toBe(expected.incomeCents)
      expect(actual!.expensesCents).toBe(expected.expensesCents)
      expect(actual!.netCents).toBe(
        expected.incomeCents - expected.expensesCents
      )
    }
  })

  it("back-calculates the balance timeline from the snapshot anchor", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, userId, "2026-08-28")
    const t = result.balanceTimeline

    // fixture: bookings start 2024-01-01, snapshot 2024-01-05 = 5.000,00 €
    // bookings ≤ snapshot: 01-01 +3500€, 01-03 −1200€, 01-05 −67,53€
    // → backward: 01-01 = 5000 + 1200 + 67,53 = 6267,53 €
    //             01-03 = 5000 + 67,53        = 5067,53 €
    // (01-05 IS the anchor point = 5000,00 €)
    expect(t.length).toBeGreaterThan(manifest.expected.monthlyCashflow.length)
    expect(t[0]).toEqual({ date: "2024-01-01", balanceCents: 626753 })
    expect(t[1]).toEqual({ date: "2024-01-03", balanceCents: 506753 })
    expect(t[2]).toEqual({ date: "2024-01-05", balanceCents: 500000 })

    // strictly ascending dates
    for (let i = 1; i < t.length; i++) {
      expect(
        t[i].date > t[i - 1].date,
        `${t[i].date} after ${t[i - 1].date}`
      ).toBe(true)
    }

    // last point equals the current balance KPI
    expect(t[t.length - 1].balanceCents).toBe(
      manifest.expected.currentBalanceCents
    )
  })

  it("top categories match hand-computed totals", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, userId, "2026-08-28")
    const actualByName = new Map(
      result.topCategories.map((c) => [c.name, c.totalCents])
    )
    for (const expected of manifest.expected.topCategories) {
      expect(actualByName.get(expected.name)).toBe(expected.totalCents)
    }
    // shares sum to ≤ 1 and top-1 is Miete (1.200,00 € / month dominates)
    expect(result.topCategories[0].name).toBe("Vermieter GmbH")
  })

  it("excludes pending rows from analytics by default but includes via status=all", () => {
    const bookedOnly = computeAnalytics(
      parseFilters(new URLSearchParams()),
      userId,
      "2026-08-28"
    )
    expect(bookedOnly.kpis.transactionCount).toBe(
      manifest.expected.transactionCount
    )
    const withPending = computeAnalytics(
      parseFilters(new URLSearchParams("status=all")),
      userId,
      "2026-08-28"
    )
    expect(withPending.kpis.transactionCount).toBe(manifest.rowCount)
  })

  it("re-import of the same fixture inserts nothing (full-file dedupe)", () => {
    const account = db
      .select()
      .from(accounts)
      .all()
      .find((a) => a.iban === manifest.account.iban)!

    const existingRows = db
      .select({
        sourceHash: transactions.sourceHash,
        occurrenceIndex: transactions.occurrenceIndex,
      })
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .all()
    const existingByHash = new Map<string, Set<number>>()
    for (const r of existingRows) {
      let set = existingByHash.get(r.sourceHash)
      if (!set) {
        set = new Set()
        existingByHash.set(r.sourceHash, set)
      }
      set.add(r.occurrenceIndex)
    }

    const parsed = parseDkbCsv(csv)
    const second = computeDedupe(
      parsed.accountIban,
      userId,
      account.id,
      "fixture-batch-2",
      parsed.rows,
      existingByHash
    )
    expect(second.toInsert).toHaveLength(0)
    expect(second.duplicateCount).toBe(parsed.rows.length)
  })
})

describe("date-filtered analytics", () => {
  const filters = (q: string) => parseFilters(new URLSearchParams(q))
  const today = "2026-08-28"
  const WINDOW = "dateFrom=2024-03-01&dateTo=2024-06-30"

  it("counts only booked transactions inside the window", () => {
    const r = computeAnalytics(filters(WINDOW), userId, today)
    // hand-derived from fixture.csv: 10 + 9 + 9 + 10 booked rows
    expect(r.kpis.transactionCount).toBe(38)
    // independent oracle: direct SQL against the in-memory db
    const oracle =
      db
        .select({ count: sql<number>`count(*)` })
        .from(transactions)
        .where(
          and(
            eq(transactions.status, "Gebucht"),
            gte(transactions.bookingDate, "2024-03-01"),
            lte(transactions.bookingDate, "2024-06-30")
          )
        )
        .get()?.count ?? 0
    expect(oracle).toBe(38)
    expect(r.kpis.transactionCount).toBe(oracle)
  })

  it("monthly cashflow is sliced to the window", () => {
    const r = computeAnalytics(filters(WINDOW), userId, today)
    expect(r.monthlyCashflow).toHaveLength(4)
    expect(r.monthlyCashflow.map((m) => m.month)).toEqual([
      "2024-03",
      "2024-04",
      "2024-05",
      "2024-06",
    ])
    expect(r.monthlyCashflow[0].incomeCents).toBe(350000)
    expect(r.monthlyCashflow[0].expensesCents).toBe(140357)
    const m06 = manifest.expected.monthlyCashflow.find(
      (m) => m.month === "2024-06"
    )!
    expect(r.monthlyCashflow[3].expensesCents).toBe(m06.expensesCents)
    expect(r.kpis.monthsCounted).toBe(4)
    // (140357 + 139273 + 144189 + 137105) / 4
    expect(r.kpis.avgMonthlyExpensesCents).toBe(Math.round(560924 / 4))
  })

  it("mid-month dateFrom excludes the partial first month from averages", () => {
    // March has data only from the 15th on → partial, not counted
    const r = computeAnalytics(
      filters("dateFrom=2024-03-15&dateTo=2024-06-30"),
      userId,
      today
    )
    // full cashflow series still starts at the window start
    expect(r.monthlyCashflow.map((m) => m.month)).toEqual([
      "2024-03",
      "2024-04",
      "2024-05",
      "2024-06",
    ])
    expect(r.kpis.monthsCounted).toBe(3)
    // (139273 + 144189 + 137105) / 3 — March's 140357 excluded
    expect(r.kpis.avgMonthlyExpensesCents).toBe(Math.round(420567 / 3))
  })

  it("window with no full month yields null averages", () => {
    // single month, both ends inside it → zero full months
    const r = computeAnalytics(
      filters("dateFrom=2024-03-15&dateTo=2024-03-31"),
      userId,
      today
    )
    expect(r.monthlyCashflow).toHaveLength(1)
    expect(r.kpis.monthsCounted).toBe(0)
    expect(r.kpis.avgMonthlyIncomeCents).toBeNull()
    expect(r.kpis.avgMonthlyExpensesCents).toBeNull()
    expect(r.kpis.savingsRate).toBeNull()
  })

  it("top categories are window-scoped", () => {
    const r = computeAnalytics(filters(WINDOW), userId, today)
    const oracle = db
      .select({
        name: categories.name,
        total: sql<number>`SUM(-${transactions.amountCents})`,
      })
      .from(transactions)
      .innerJoin(categories, eq(transactions.categoryId, categories.id))
      .where(
        and(
          eq(transactions.status, "Gebucht"),
          gte(transactions.bookingDate, "2024-03-01"),
          lte(transactions.bookingDate, "2024-06-30"),
          sql`${transactions.amountCents} < 0`
        )
      )
      .groupBy(categories.name)
      .orderBy(sql`SUM(-${transactions.amountCents}) DESC`)
      .all()
    // no Langtext GmbH inside the window
    expect(r.topCategories).toHaveLength(4)
    expect(r.topCategories[0]).toMatchObject({
      name: "Vermieter GmbH",
      totalCents: 480000,
      txCount: 4,
    })
    const byName = new Map(r.topCategories.map((c) => [c.name, c.totalCents]))
    expect(byName.get("Supermarkt")).toBe(72928)
    expect(byName.get("Streaming AG")).toBe(5196)
    expect(byName.get("Cafe Mittelmeer")).toBe(2800)
    for (const row of oracle) {
      expect(byName.get(row.name)).toBe(Number(row.total))
    }
  })

  it("balance ignores content filters (q/type/categoryId/labelStatus)", () => {
    const cat = db
      .select()
      .from(categories)
      .where(eq(categories.nameKey, "supermarkt"))
      .get()
    expect(cat).toBeDefined()

    const plain = computeAnalytics(filters(WINDOW), userId, today)
    const filtered = computeAnalytics(
      filters(
        `${WINDOW}&q=Supermarkt&type=Ausgang&categoryId=${cat!.id}&labelStatus=labeled`
      ),
      userId,
      today
    )
    expect(filtered.kpis.currentBalanceCents).toBe(
      plain.kpis.currentBalanceCents
    )
    expect(filtered.balanceTimeline).toEqual(plain.balanceTimeline)

    // q matching NOTHING still yields a balance (flow aggregates empty out)
    const none = computeAnalytics(filters("q=EDEKA"), userId, today)
    expect(
      none.monthlyCashflow.every(
        (m) => m.incomeCents === 0 && m.expensesCents === 0
      )
    ).toBe(true)
    expect(none.kpis.transactionCount).toBe(0)
    expect(none.kpis.currentBalanceCents).toBe(
      manifest.expected.currentBalanceCents
    )
    expect(none.kpis.balanceWithoutSnapshot).toBe(false)
  })

  it("balance ignores the status filter (pending rows never enter it)", () => {
    // the fixture contains pending rows; a status=all/pending query must not
    // make the balance count money that has not actually moved
    const plain = computeAnalytics(filters(""), userId, today)
    for (const status of ["status=all", "status=Nicht gebucht"]) {
      const r = computeAnalytics(filters(status), userId, today)
      expect(r.kpis.currentBalanceCents).toBe(plain.kpis.currentBalanceCents)
      expect(r.balanceTimeline).toEqual(plain.balanceTimeline)
    }
    // sanity: the flow scope DOES react to status (pending rows are 24)
    const pendingOnly = computeAnalytics(
      filters("status=Nicht gebucht"),
      userId,
      today
    )
    expect(pendingOnly.kpis.transactionCount).toBe(manifest.pendingCount)
  })

  it("balance KPI = balance as of dateTo (dateTo ≥ anchor)", () => {
    const r = computeAnalytics(filters("dateTo=2024-01-08"), userId, today)
    // next booking after the anchor (2024-01-05, 5.000,00 €) is 2024-01-10
    expect(r.kpis.currentBalanceCents).toBe(500000)
    expect(r.balanceTimeline[r.balanceTimeline.length - 1]).toEqual({
      date: "2024-01-05",
      balanceCents: 500000,
    })
  })

  it("balance KPI as of dateTo BEFORE the anchor uses backward math", () => {
    const r = computeAnalytics(filters("dateTo=2024-01-03"), userId, today)
    // anchor 500000 − Σ(booked in (2024-01-03, 2024-01-05]) = 500000 + 6753
    expect(r.kpis.currentBalanceCents).toBe(506753)
    expect(r.balanceTimeline).toEqual([
      { date: "2024-01-01", balanceCents: 626753 },
      { date: "2024-01-03", balanceCents: 506753 },
    ])
  })

  it("balance timeline is the full timeline sliced to [dateFrom, dateTo]", () => {
    const un = computeAnalytics(filters(""), userId, today)
    const byDate = new Map(
      un.balanceTimeline.map((p) => [p.date, p.balanceCents])
    )
    const r = computeAnalytics(
      filters("dateFrom=2024-02-01&dateTo=2024-02-29"),
      userId,
      today
    )
    expect(r.balanceTimeline).toHaveLength(6)
    expect(r.balanceTimeline[0]).toEqual({
      date: "2024-02-01",
      balanceCents: 834228,
    })
    expect(r.balanceTimeline[5]).toEqual({
      date: "2024-02-20",
      balanceCents: 692787,
    })
    for (const p of r.balanceTimeline) {
      expect(p.date >= "2024-02-01" && p.date <= "2024-02-29").toBe(true)
      // slice-not-recompute oracle: values match the unfiltered timeline
      expect(p.balanceCents).toBe(byDate.get(p.date))
    }
    expect(r.kpis.currentBalanceCents).toBe(692787)
  })

  it("dateTo covering everything is equivalent to no filter", () => {
    const un = computeAnalytics(filters(""), userId, today)
    const r = computeAnalytics(filters("dateTo=2025-12-31"), userId, today)
    expect(r).toEqual(un)
    expect(r.kpis.currentBalanceCents).toBe(
      manifest.expected.currentBalanceCents
    )
  })
})

describe("savings history (last 6 complete months)", () => {
  const filters = (q: string) => parseFilters(new URLSearchParams(q))

  /** net per month, derived from the manifest's income/expenses */
  const netOf = (month: string) => {
    const m = manifest.expected.monthlyCashflow.find((x) => x.month === month)!
    return m.incomeCents - m.expensesCents
  }

  it("ends at the previous calendar month with a zero-filled 6-month window", () => {
    const r = computeAnalytics(filters(""), userId, "2026-01-15")
    expect(r.savingsHistory).not.toBeNull()
    const s = r.savingsHistory!
    expect(s.lastMonth).toBe("2025-12")
    expect(s.lastMonthNetCents).toBe(netOf("2025-12"))
    expect(s.months.map((m) => m.month)).toEqual([
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
    ])
    for (const m of s.months) {
      expect(m.netCents).toBe(netOf(m.month))
    }
  })

  it("falls back to the latest booking month for stale imports", () => {
    // fixture data ends 2025-12, "today" is Aug 2026 → no zero-filled gap
    const r = computeAnalytics(filters(""), userId, "2026-08-28")
    const s = r.savingsHistory!
    expect(s.lastMonth).toBe("2025-12")
    expect(s.months.map((m) => m.month)).toEqual([
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
    ])
  })

  it("ignores content and date filters entirely", () => {
    const un = computeAnalytics(filters(""), userId, "2026-01-15")
    const filtered = computeAnalytics(
      filters(
        "dateFrom=2024-03-01&dateTo=2024-06-30&q=Supermarkt&type=Ausgang"
      ),
      userId,
      "2026-01-15"
    )
    expect(filtered.savingsHistory).toEqual(un.savingsHistory)
  })

  it("ignores the status filter (booked rows only)", () => {
    // savings is a booked-rows-only series; status=all or pending-only
    // queries must not alter it
    const un = computeAnalytics(filters(""), userId, "2026-01-15")
    for (const status of ["status=all", "status=Nicht gebucht"]) {
      const r = computeAnalytics(filters(status), userId, "2026-01-15")
      expect(r.savingsHistory).toEqual(un.savingsHistory)
    }
  })

  it("never claims the running month as last complete month", () => {
    // fixture data ends 2025-12 but today is Jan 2026: prevOfToday (2025-12)
    // equals latestBookingMonth → series must end there either way
    const r = computeAnalytics(filters(""), userId, "2026-01-31")
    expect(r.savingsHistory!.lastMonth).toBe("2025-12")
    // window is always exactly 6 months
    expect(r.savingsHistory!.months).toHaveLength(6)
  })

  it("exposes the running month separately from the complete window", () => {
    // today = mid-Dec 2025: 2025-12 is still running → months window ends
    // at 2025-11, and 2025-12 (which HAS bookings) is the currentMonth
    const r = computeAnalytics(filters(""), userId, "2025-12-15")
    const s = r.savingsHistory!
    expect(s.lastMonth).toBe("2025-11")
    expect(s.months.map((m) => m.month)).not.toContain("2025-12")
    expect(s.currentMonth).not.toBeNull()
    expect(s.currentMonth!.month).toBe("2025-12")
    expect(s.currentMonth!.netCents).toBe(netOf("2025-12"))
  })

  it("currentMonth is null when the running month has no bookings", () => {
    // today = Aug 2026, fixture data ends 2025-12 (stale import)
    const r = computeAnalytics(filters(""), userId, "2026-08-28")
    expect(r.savingsHistory!.currentMonth).toBeNull()
  })

  it("is null when the account has no transactions at all", () => {
    // savings history ignores content filters but respects the account
    const r = computeAnalytics(filters("accountId=99999"), userId, "2026-01-15")
    expect(r.savingsHistory).toBeNull()
  })

  it("never claims a future-dated booking's month as last complete month", () => {
    // today mid-Jan 2026, one booking dated in Aug 2026 (future-dated
    // import): latestBookingMonth (2026-08) > prevOfToday (2025-12), so
    // the window must still end at 2025-12 — not at the future month
    const account = db
      .select()
      .from(accounts)
      .all()
      .find((a) => a.iban === manifest.account.iban)!
    db.insert(transactions)
      .values({
        id: "future-dated",
        userId: account.userId,
        accountId: account.id,
        batchId: "fixture-batch",
        bookingDate: "2026-08-10",
        status: "Gebucht",
        type: "Eingang",
        amountCents: 12345,
        sourceHash: "future-dated-hash",
        occurrenceIndex: 0,
      })
      .run()

    try {
      const r = computeAnalytics(filters(""), userId, "2026-01-15")
      const s = r.savingsHistory!
      expect(s.lastMonth).toBe("2025-12")
      expect(s.months).toHaveLength(6)
      // the running month (2026-01) has no bookings of its own
      expect(s.currentMonth).toBeNull()
    } finally {
      // cleanup so other tests see the fixture's original state
      db.delete(transactions).where(eq(transactions.id, "future-dated")).run()
    }
  })

  it("marks the headline as stale when imports stopped months ago", () => {
    // stale case: data ends 2025-12, today is Aug 2026
    const r = computeAnalytics(filters(""), userId, "2026-08-28")
    expect(r.savingsHistory!.lastMonthIsStale).toBe(true)

    // fresh case: data reaches the previous calendar month
    const fresh = computeAnalytics(filters(""), userId, "2026-01-15")
    expect(fresh.savingsHistory!.lastMonthIsStale).toBe(false)
  })
})
