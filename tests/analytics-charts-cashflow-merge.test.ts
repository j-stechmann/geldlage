import { describe, it, expect } from "vitest"
import { mergeCashflow } from "@/components/analytics-charts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import type { ForecastResult } from "@/components/planning/api"

/**
 * Zero-row + sign regression (planned-vs-actual Monats-Cashflow):
 *
 * 1. recharts keeps tooltip items with `value != null`, so a 0 planned
 *    segment would print a "0,00 € geplant"-noise row under every history
 *    month — months without planned money carry `undefined` instead.
 * 2. The Ist expense bar renders the wire's positive `expensesCents`
 *    NEGATED (downward, the app's original cashflow convention); planned
 *    expenses mirror that sign so the forecast stack (stackOffset "sign")
 *    lands BELOW the actual outflow instead of inside the income pile.
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

type PlannedMonth = ForecastResult["monthlyPlanned"][number]

function plannedMonth(over: Partial<PlannedMonth> = {}): PlannedMonth {
  return {
    month: "2026-11",
    incomeCents: 80_000,
    expensesCents: 20_000,
    netCents: 60_000,
    ...over,
  }
}

function forecast(monthlyPlanned: PlannedMonth[]): ForecastResult {
  return {
    startingBalanceCents: 0,
    withoutSnapshot: false,
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2027-10-31" },
    monthlyPlanned,
    projectedBalance: [],
    plannedCategories: [],
  }
}

describe("mergeCashflow", () => {
  it("keeps the Ist values with planned fields undefined when the forecast is off", () => {
    const rows = mergeCashflow([historyRow()], undefined)
    expect(rows[0]).toEqual({
      month: "2026-08",
      income: 3000,
      expenses: -1500,
      net: 1500,
      plannedIncome: undefined,
      plannedExpenses: undefined,
    })
  })

  it("stacks planned money onto the existing month with matching signs", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2026-10" })],
      forecast([plannedMonth({ month: "2026-10" })])
    )
    expect(rows[0].income).toBe(3000)
    expect(rows[0].expenses).toBe(-1500)
    // planned income stacks upward, planned expenses downward (sign parity)
    expect(rows[0].plannedIncome).toBe(800)
    expect(rows[0].plannedExpenses).toBe(-200)
    expect(rows[0].net).toBe(2100) // Ist net + planned net
  })

  it("plan-only months carry undefined Ist segments and stay sorted ascending", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2027-01" })],
      forecast([
        plannedMonth({ month: "2026-11", incomeCents: 0, netCents: -20_000 }),
      ])
    )
    expect(rows.map((r) => r.month)).toEqual(["2026-11", "2027-01"])
    expect(rows[0].income).toBeUndefined()
    expect(rows[0].expenses).toBeUndefined()
    expect(rows[0].plannedIncome).toBeUndefined()
    expect(rows[0].plannedExpenses).toBe(-200)
    expect(rows[0].net).toBe(-200)
  })

  it("history months without planned money keep planned fields undefined (not 0)", () => {
    const rows = mergeCashflow(
      [historyRow({ month: "2026-10" })],
      forecast([plannedMonth({ month: "2026-11" })])
    )
    expect(rows[0].plannedIncome).toBeUndefined()
    expect(rows[0].plannedExpenses).toBeUndefined()
  })
})
