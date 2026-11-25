import { describe, it, expect } from "vitest"
import { mergeCashflow } from "@/components/analytics-charts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import type { PredictionForecast } from "@/lib/contracts/prediction"

/**
 * Zero-row + sign regression for the always-on daily prediction:
 *
 * 1. Recharts keeps tooltip items with `value != null`, so a 0 prediction
 *    segment would print a "0,00 €" noise row under every history month —
 *    months without predicted money carry `undefined` instead.
 * 2. The Ist expense bar renders the wire's positive `expensesCents`
 *    NEGATED (downward); predicted expenses mirror that sign so the
 *    stackOffset "sign" stack lands below the actual outflow.
 */

type HistoryRow = AnalyticsResponse["monthlyCashflow"][number]

function historyRow(over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    month: "2026-08",
    incomeCents: 300_000,
    expensesCents: 150_000,
    netCents: 150_000,
    ...over,
  }
}

function prediction(
  monthly: PredictionForecast["monthly"]
): PredictionForecast {
  return {
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2026-12-31", months: 2 },
    startingBalanceCents: 0,
    withoutSnapshot: false,
    monthly,
    daily: [],
    projectedBalance: [],
    source: "model",
    pending: false,
    retryAt: null,
  }
}

function month(
  over: Partial<PredictionForecast["monthly"][number]> = {}
): PredictionForecast["monthly"][number] {
  return {
    month: "2026-11",
    partial: false,
    incomeCents: 80_000,
    expensesCents: 20_000,
    netCents: 60_000,
    bookedFuture: { incomeCents: 0, expensesCents: 0 },
    categories: [],
    ...over,
  }
}

describe("mergeCashflow", () => {
  it("keeps the Ist values with predicted fields undefined without a prediction", () => {
    const rows = mergeCashflow([historyRow()], undefined)
    expect(rows[0]).toEqual({
      month: "2026-08",
      income: 3000,
      expenses: -1500,
      net: 1500,
      predictedIncome: undefined,
      predictedExpenses: undefined,
    })
  })

  it("stacks predicted money onto the current month with matching signs", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2026-10" })],
      prediction([month({ month: "2026-10" })])
    )
    expect(rows[0].income).toBe(3000)
    expect(rows[0].expenses).toBe(-1500)
    expect(rows[0].predictedIncome).toBe(800)
    expect(rows[0].predictedExpenses).toBe(-200)
    expect(rows[0].net).toBe(2100)
  })

  it("prediction-only months carry undefined Ist segments and stay sorted", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2027-01" })],
      prediction([
        month({ month: "2026-11", incomeCents: 0, netCents: -20_000 }),
      ])
    )
    expect(rows.map((r) => r.month)).toEqual(["2026-11", "2027-01"])
    expect(rows[0].income).toBeUndefined()
    expect(rows[0].expenses).toBeUndefined()
    expect(rows[0].predictedIncome).toBeUndefined()
    expect(rows[0].predictedExpenses).toBe(-200)
    expect(rows[0].net).toBe(-200)
  })

  it("carries booked-future money into a prediction-only month", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2026-10" })],
      prediction([
        month({
          month: "2026-12",
          incomeCents: 0,
          expensesCents: 0,
          bookedFuture: { incomeCents: 50_000, expensesCents: 10_000 },
        }),
      ])
    )
    expect(rows.at(-1)).toMatchObject({
      month: "2026-12",
      predictedIncome: 500,
      predictedExpenses: -100,
    })
  })

  it("ignores bookedFuture when the actual month already exists", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2026-11" })],
      prediction([
        month({
          month: "2026-11",
          bookedFuture: { incomeCents: 50_000, expensesCents: 10_000 },
        }),
      ])
    )
    expect(rows[0].predictedExpenses).toBe(-200)
    expect(rows[0].predictedIncome).toBe(800)
  })

  it("history months without predicted money keep predicted fields undefined", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2026-10" })],
      prediction([month({ month: "2026-11" })])
    )
    expect(rows[0].predictedIncome).toBeUndefined()
    expect(rows[0].predictedExpenses).toBeUndefined()
  })
})
