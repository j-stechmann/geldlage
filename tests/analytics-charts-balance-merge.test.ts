import { describe, it, expect } from "vitest"
import { mergeBalance } from "@/components/analytics-charts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import type { ForecastResult } from "@/components/planning/api"

/**
 * Connection-point regression (Prognose overlay on the balance timeline):
 * the dashed series must connect to the real history at the projection's own
 * baseline. When the history ends ON today, that baseline is the projection's
 * today point — it already folds the planned occurrences dated today into its
 * balance, while the history's last row is booked-only. Anchoring the dashed
 * line at the booked-only value would shift today's planned movement onto the
 * next plotted date (and drop it from the line entirely when no later
 * movement exists).
 */

type HistoryPoint = AnalyticsResponse["balanceTimeline"][number]

function historyPoint(over: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    date: "2026-10-27",
    balanceCents: 100_000,
    ...over,
  }
}

type ProjectionPoint = ForecastResult["projectedBalance"][number]

function projectionPoint(date: string, balanceCents: number): ProjectionPoint {
  return { date, balanceCents }
}

function forecast(projectedBalance: ProjectionPoint[]): ForecastResult {
  return {
    startingBalanceCents: 100_000,
    withoutSnapshot: false,
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2027-10-31" },
    monthlyPlanned: [],
    projectedBalance,
    plannedCategories: [],
  }
}

describe("mergeBalance", () => {
  it("keeps the plain history when the forecast is off", () => {
    const rows = mergeBalance([historyPoint()], undefined)
    expect(rows).toEqual([
      { date: "2026-10-27", balance: 1000, projected: null },
    ])
  })

  it("connects at the projection's today point when the history ends today", () => {
    const fc = forecast([
      projectionPoint("2026-10-27", 150_000), // 1.000 € Ist + 500 € geplant heute
      projectionPoint("2026-11-01", 160_000),
    ])
    const rows = mergeBalance([historyPoint({ balanceCents: 100_000 })], fc)
    // one merged row per date: at today the row carries both series, and the
    // dashed value is the projection's today point (incl. planned-today) —
    // not the booked-only balance it used to anchor at
    expect(rows).toEqual([
      { date: "2026-10-27", balance: 1000, projected: 1500 },
      { date: "2026-11-01", balance: null, projected: 1600 },
    ])
  })

  it("without planned occurrences today, the connection value equals the booked balance", () => {
    const fc = forecast([projectionPoint("2026-10-27", 100_000)])
    const rows = mergeBalance([historyPoint({ balanceCents: 100_000 })], fc)
    expect(rows).toEqual([
      { date: "2026-10-27", balance: 1000, projected: 1000 },
    ])
  })

  it("a history ending before today anchors at its own point and plots today's projection separately", () => {
    const fc = forecast([
      projectionPoint("2026-10-27", 150_000),
      projectionPoint("2026-11-01", 160_000),
    ])
    const rows = mergeBalance(
      [historyPoint({ date: "2026-10-20", balanceCents: 90_000 })],
      fc
    )
    expect(rows).toEqual([
      { date: "2026-10-20", balance: 900, projected: 900 },
      { date: "2026-10-27", balance: null, projected: 1500 },
      { date: "2026-11-01", balance: null, projected: 1600 },
    ])
  })

  it("a history extending beyond today suppresses the projection line", () => {
    const fc = forecast([projectionPoint("2026-10-27", 100_500)])
    const rows = mergeBalance(
      [historyPoint({ date: "2026-11-05", balanceCents: 120_000 })],
      fc
    )
    expect(rows).toEqual([
      { date: "2026-11-05", balance: 1200, projected: null },
    ])
  })

  it("history-less users render the dashed projection alone from today", () => {
    const fc = forecast([
      projectionPoint("2026-10-27", 100_000),
      projectionPoint("2026-11-01", 101_000),
    ])
    const rows = mergeBalance([], fc)
    expect(rows).toEqual([
      { date: "2026-10-27", balance: null, projected: 1000 },
      { date: "2026-11-01", balance: null, projected: 1010 },
    ])
  })
})
