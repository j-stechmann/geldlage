import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import {
  accounts,
  categories,
  importBatches,
  plannedTransactions,
  transactions,
} from "@/lib/db/schema"
import { setupTestDb } from "./helpers"

const IBAN = "DE02120300000000202051"

let db: Db
let userId: number
let accountId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  accountId = db
    .insert(accounts)
    .values({ userId, iban: IBAN, name: "Girokonto" })
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

function seedTx(
  bookingDate: string,
  amountCents: number,
  overrides: Partial<typeof transactions.$inferInsert> = {}
) {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId,
      bookingDate,
      status: "Gebucht",
      payer: "Gehaltsabrechnung GmbH",
      payee: "Mietwerk GmbH",
      type: amountCents > 0 ? "Eingang" : "Ausgang",
      amountCents,
      sourceHash: `hash-${id}`,
      ...overrides,
    })
    .run()
  return id
}

function seedPlan(overrides: Partial<typeof plannedTransactions.$inferInsert>) {
  return db
    .insert(plannedTransactions)
    .values({
      id: `plan-${crypto.randomUUID()}`,
      userId,
      accountId,
      amountCents: -100_00,
      dtstart: "2026-01-01",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    })
    .returning()
    .get()
}

// Hand-computed scenario (ADR-0021 oracle style): all expected values below
// were computed by hand, to the cent.
//
// today = 2026-03-15, horizon = 2 months → [2026-03-15, 2026-04-30]
//
// History:  snapshot 2026-01-31 = 2.000,00 €
//           2026-02-05 −500,00    2026-03-01 −200,00
//           2026-03-10 +1.500,00  2026-03-20 −100,00 (booked, after today)
// ⇒ starting balance = 2.000,00 − 500,00 − 200,00 + 1.500,00 = 2.800,00 €
//
// Plans:    A rent    monthly on the 1st  −950,00 €  (Miete category)
//           B salary  monthly on the 15th +1.500,00 € — the 2026-03-15
//                     occurrence MATCHES the booked 2026-03-10 row (−5 days)
//                     ⇒ excluded from all planned aggregates
//           C one-off 2026-03-20 −299,00 € uncategorized
//           D weekly  every Monday from 2026-03-02 (MO) −12,34 €:
//                     03-16, 03-23, 03-30 (March) + 04-06, 04-13, 04-20,
//                     04-27 (April)
//
// March planned: 299,00 + 3×12,34 = 336,02 € (expenses)
// April planned: 1.500,00 income; 95,00 + 4×12,34 = 143,36 € (expenses)
describe("computeForecast", () => {
  let computeForecast: (typeof import("@/lib/planning/service"))["computeForecast"]

  beforeEach(async () => {
    ;({ computeForecast } = await import("@/lib/planning/service"))
  })

  it("projects balance and planned sums to the cent", () => {
    seedBatch({ snapshotDate: "2026-01-31", snapshotAmountCents: 200_000 })
    seedTx("2026-02-05", -50_000)
    seedTx("2026-03-01", -20_000)
    seedTx("2026-03-10", +150_000)
    seedTx("2026-03-20", -10_000) // future-booked certainty also moves the line

    const mieteCategory = db
      .insert(categories)
      .values({
        userId,
        name: "Miete",
        nameKey: "miete",
        language: "de",
        origin: "manual",
        color: "#ff0000",
      })
      .returning()
      .get()
    seedPlan({
      amountCents: -95_000,
      dtstart: "2026-01-01",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
      counterparty: "Mietwerk GmbH",
      categoryId: mieteCategory.id,
      status: "active",
    })
    void mieteCategory
    seedPlan({
      // salary B; the occurrence on 2026-03-15 matches the 2026-03-10 row
      amountCents: +150_000,
      dtstart: "2026-02-15",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15",
      counterparty: "Gehalt",
      status: "active",
    })
    seedPlan({
      // one-off C, no account restriction, no counterparty
      amountCents: -29_900,
      dtstart: "2026-03-20",
      rrule: null,
      accountId: null,
      status: "active",
    })
    seedPlan({
      // weekly D
      amountCents: -1_234,
      dtstart: "2026-03-02",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      counterparty: null,
      status: "active",
    })

    const forecast = computeForecast(userId, {
      months: 2,
      today: "2026-03-15",
    })

    expect(forecast.today).toBe("2026-03-15")
    expect(forecast.horizon).toEqual({ from: "2026-03-15", to: "2026-04-30" })
    expect(forecast.withoutSnapshot).toBe(false)
    expect(forecast.startingBalanceCents).toBe(280_000)

    // monthly planned (matched salary occurrence on 03-15 excluded)
    expect(forecast.monthlyPlanned).toEqual([
      {
        month: "2026-03",
        // one-off C (299,00) + weekly D 3× (12,34) = 299,00 + 37,02 = 336,02 €
        incomeCents: 0,
        expensesCents: 29_900 + 3 * 1_234,
        netCents: -(29_900 + 3 * 1_234),
      },
      {
        month: "2026-04",
        incomeCents: 150_000,
        expensesCents: 95_000 + 4 * 1_234,
        netCents: 150_000 - (95_000 + 4 * 1_234),
      },
    ])

    // projected timeline: today, then each day with movement
    expect(forecast.projectedBalance).toEqual([
      { date: "2026-03-15", balanceCents: 280_000 },
      { date: "2026-03-16", balanceCents: 280_000 - 1_234 },
      { date: "2026-03-20", balanceCents: 280_000 - 1_234 - 29_900 - 10_000 },
      {
        date: "2026-03-23",
        balanceCents: 280_000 - 1_234 - 29_900 - 10_000 - 1_234,
      },
      {
        date: "2026-03-30",
        balanceCents: 280_000 - 1_234 - 29_900 - 10_000 - 2 * 1_234,
      },
      {
        date: "2026-04-01",
        balanceCents: 280_000 - 1_234 - 29_900 - 10_000 - 2 * 1_234 - 95_000,
      },
      {
        date: "2026-04-06",
        balanceCents:
          280_000 - 1_234 - 29_900 - 10_000 - 2 * 1_234 - 95_000 - 1_234,
      },
      {
        date: "2026-04-13",
        balanceCents:
          280_000 - 1_234 - 29_900 - 10_000 - 2 * 1_234 - 95_000 - 2 * 1_234,
      },
      {
        date: "2026-04-15",
        balanceCents:
          280_000 -
          1_234 -
          29_900 -
          10_000 -
          2 * 1_234 -
          95_000 -
          2 * 1_234 +
          150_000,
      },
      {
        date: "2026-04-20",
        balanceCents:
          280_000 -
          1_234 -
          29_900 -
          10_000 -
          2 * 1_234 -
          95_000 -
          2 * 1_234 +
          150_000 -
          1_234,
      },
      {
        date: "2026-04-27",
        balanceCents:
          280_000 -
          1_234 -
          29_900 -
          10_000 -
          2 * 1_234 -
          95_000 -
          2 * 1_234 +
          150_000 -
          2 * 1_234,
      },
    ])

    // planned expenses per category: Miete 950,00 € first (desc), the rest
    // (one-off C + all weekly D) lands in the "ohne Kategorie" bucket
    const ohne = 29_900 + 7 * 1_234
    expect(forecast.plannedCategories).toEqual([
      {
        categoryId: mieteCategory.id,
        name: "Miete",
        color: mieteCategory.color,
        totalCents: 95_000,
        share: 95_000 / (95_000 + ohne),
      },
      {
        categoryId: null,
        name: "ohne Kategorie",
        color: null,
        totalCents: ohne,
        share: ohne / (95_000 + ohne),
      },
    ])
  })

  it("plans in a no-snapshot database start from Σ(booked ≤ today)", () => {
    seedTx("2026-03-01", -10_000)
    seedTx("2026-03-14", +5_000)
    const forecast = computeForecast(userId, { months: 1, today: "2026-03-15" })
    expect(forecast.withoutSnapshot).toBe(true)
    expect(forecast.startingBalanceCents).toBe(-10_000 + 5_000)
  })

  it("honours the account filter for anchors, booking sums and plans", () => {
    seedBatch({ snapshotDate: "2026-01-31", snapshotAmountCents: 100_000 })
    seedTx("2026-02-01", -10_000)
    const other = db
      .insert(accounts)
      .values({ userId, iban: "DE02500105170137075072962", name: "Sparen" })
      .returning()
      .get()
    seedBatch({
      accountId: other.id,
      snapshotDate: "2026-01-31",
      snapshotAmountCents: 900_000,
    })
    seedPlan({ dtstart: "2026-03-20", amountCents: -5_000, rrule: null })

    // account-scoped forecast: only account 1
    const scoped = computeForecast(userId, {
      months: 1,
      today: "2026-03-15",
      accountId,
    })
    expect(scoped.startingBalanceCents).toBe(100_000 - 10_000)
    // the plan (accounted to account 1) is in scope
    expect(scoped.monthlyPlanned).toHaveLength(1)
    expect(scoped.monthlyPlanned[0]?.expensesCents).toBe(5_000)

    // account-agnostic plans also appear under other accounts; the seeded
    // plan here has account 1, so the second account only sees its balance
    const otherForecast = computeForecast(userId, {
      months: 1,
      today: "2026-03-15",
      accountId: other.id,
    })
    expect(otherForecast.startingBalanceCents).toBe(900_000)
    expect(otherForecast.monthlyPlanned).toHaveLength(0)
  })

  it("same-snapshotDate batches tie-break deterministically: freshest import wins", () => {
    seedBatch({ snapshotDate: "2025-06-30", snapshotAmountCents: 10_000 })
    // two batches tied on snapshotDate (two accounts imported on one day);
    // inserted OLDER-createdAt first to prove the pick is the explicit
    // (createdAt, id) rule, not scan order
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

    const forecast = computeForecast(userId, { months: 1, today: "2026-02-15" })
    expect(forecast.withoutSnapshot).toBe(false)
    // the 18:00 batch beats the 10:00 batch even though the 10:00 batch was
    // inserted (and would be scanned) first
    expect(forecast.startingBalanceCents).toBe(300_000 - 50_000)
  })

  it("finished and paused plans behave: finished never expands, paused does", () => {
    seedBatch({ snapshotDate: "2026-01-31", snapshotAmountCents: 100_000 })
    seedPlan({
      dtstart: "2026-03-20",
      amountCents: -5_000,
      rrule: null,
      status: "finished",
    })
    seedPlan({
      dtstart: "2026-03-21",
      amountCents: -6_000,
      rrule: null,
      status: "paused",
    })

    const forecast = computeForecast(userId, { months: 1, today: "2026-03-15" })
    expect(forecast.monthlyPlanned).toHaveLength(1)
    expect(forecast.monthlyPlanned[0]?.expensesCents).toBe(6_000)
  })

  it("months clamps into [1, 60] and invalid input falls back to 12", () => {
    seedBatch({ snapshotDate: "2026-01-31", snapshotAmountCents: 100_000 })
    const one = computeForecast(userId, { months: 1, today: "2026-03-15" })
    expect(one.horizon.to).toBe("2026-03-31")
    const fallback = computeForecast(userId, {
      months: -5,
      today: "2026-03-15",
    })
    expect(fallback.horizon.to).toBe("2027-02-28")
    const clamped = computeForecast(userId, {
      months: 500,
      today: "2026-03-15",
    })
    expect(clamped.horizon.to).toBe("2031-02-28")
  })

  // Horizon edge (regression): a match whose booking posts AFTER horizonEnd
  // is outside the projection's real data entirely (starting balance stops
  // at today, realFuture at horizonEnd) — the planned occurrence must stay
  // counted, otherwise the money appears in neither aggregate.
  it("keeps a match booked past horizonEnd counted as planned", () => {
    seedBatch({ snapshotDate: "2026-01-31", snapshotAmountCents: 100_000 })
    seedPlan({
      amountCents: -95_000,
      dtstart: "2026-01-27",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=27",
      counterparty: "Mietwerk GmbH",
    })

    // booking posts 2026-04-02 (+6 days from the 03-27 occurrence, inside
    // the +7 match window) — after the horizon end 2026-03-31
    seedTx("2026-04-02", -95_000, { payee: "Mietwerk GmbH" })

    const after = computeForecast(userId, { months: 1, today: "2026-03-15" })
    expect(after.horizon).toEqual({ from: "2026-03-15", to: "2026-03-31" })
    // the March occurrence is the only in-horizon representation → counted
    expect(after.monthlyPlanned).toEqual([
      {
        month: "2026-03",
        incomeCents: 0,
        expensesCents: 95_000,
        netCents: -95_000,
      },
    ])
    expect(after.projectedBalance).toEqual([
      { date: "2026-03-15", balanceCents: 100_000 },
      { date: "2026-03-27", balanceCents: 5_000 },
    ])
    expect(after.plannedCategories).toEqual([
      {
        categoryId: null,
        name: "ohne Kategorie",
        color: null,
        totalCents: 95_000,
        share: 1,
      },
    ])
  })

  // the double-count protection itself, at the same horizon: a booking
  // dated ON horizonEnd is real in-horizon money — the occurrence stays
  // excluded and the realFuture balance point carries the amount instead
  it("stays excluded when the match books on horizonEnd", () => {
    seedBatch({ snapshotDate: "2026-01-31", snapshotAmountCents: 100_000 })
    seedPlan({
      amountCents: -95_000,
      dtstart: "2026-01-27",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=27",
      counterparty: "Mietwerk GmbH",
    })
    seedTx("2026-03-31", -95_000, { payee: "Mietwerk GmbH" })

    const inside = computeForecast(userId, { months: 1, today: "2026-03-15" })
    expect(inside.monthlyPlanned).toEqual([])
    expect(inside.projectedBalance).toEqual([
      { date: "2026-03-15", balanceCents: 100_000 },
      { date: "2026-03-31", balanceCents: 5_000 },
    ])
  })
})
