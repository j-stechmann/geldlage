import { describe, it, expect } from "vitest"
import { mergeBalance } from "@/components/analytics-charts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import type { PredictionForecast } from "@/lib/contracts/prediction"

/**
 * Connection-point regression for the always-on daily prediction: the dashed
 * series connects to booked history at the prediction's own today point.
 * Post-dated history is clipped at today so the projection remains visible;
 * actual rows beyond the prediction horizon are appended as a tail.
 */

type HistoryPoint = AnalyticsResponse["balanceTimeline"][number]

function historyPoint(over: Partial<HistoryPoint> = {}): HistoryPoint {
  return { date: "2026-10-27", balanceCents: 100_000, ...over }
}

type ProjectionPoint = PredictionForecast["projectedBalance"][number]

function projectionPoint(date: string, balanceCents: number): ProjectionPoint {
  return { date, balanceCents }
}

function prediction(projectedBalance: ProjectionPoint[]): PredictionForecast {
  return {
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2026-12-31", months: 2 },
    startingBalanceCents: 100_000,
    withoutSnapshot: false,
    daily: [],
    monthly: [],
    projectedBalance,
    source: "model",
    pending: false,
    retryAt: null,
  }
}

describe("mergeBalance", () => {
  it("keeps the plain history without a prediction", () => {
    const rows = mergeBalance([historyPoint()], undefined)
    expect(rows).toEqual([
      { date: "2026-10-27", balance: 1000, projected: null },
    ])
  })

  it("connects at the prediction's today point when history ends today", () => {
    const rows = mergeBalance(
      [historyPoint({ balanceCents: 100_000 })],
      prediction([
        projectionPoint("2026-10-27", 150_000),
        projectionPoint("2026-11-01", 160_000),
      ])
    )
    expect(rows).toEqual([
      { date: "2026-10-27", balance: 1000, projected: 1500 },
      { date: "2026-11-01", balance: null, projected: 1600 },
    ])
  })

  it("anchors a history ending before today at its own point", () => {
    const rows = mergeBalance(
      [historyPoint({ date: "2026-10-20", balanceCents: 90_000 })],
      prediction([
        projectionPoint("2026-10-27", 150_000),
        projectionPoint("2026-11-01", 160_000),
      ])
    )
    expect(rows).toEqual([
      { date: "2026-10-20", balance: 900, projected: 900 },
      { date: "2026-10-27", balance: null, projected: 1500 },
      { date: "2026-11-01", balance: null, projected: 1600 },
    ])
  })

  it("clips post-dated history at today and keeps the projection visible", () => {
    const rows = mergeBalance(
      [
        historyPoint({ date: "2026-10-20", balanceCents: 90_000 }),
        historyPoint({ date: "2026-11-05", balanceCents: 120_000 }),
      ],
      prediction([
        projectionPoint("2026-10-27", 100_500),
        projectionPoint("2026-11-05", 120_500),
      ])
    )
    expect(rows).toEqual([
      { date: "2026-10-20", balance: 900, projected: 900 },
      { date: "2026-10-27", balance: null, projected: 1005 },
      { date: "2026-11-05", balance: null, projected: 1205 },
    ])
  })

  it("keeps booked history beyond the prediction horizon", () => {
    const rows = mergeBalance(
      [
        historyPoint({ date: "2026-12-30", balanceCents: 90_000 }),
        historyPoint({ date: "2027-02-01", balanceCents: 130_000 }),
      ],
      prediction([projectionPoint("2026-10-27", 100_500)])
    )
    expect(rows.at(-1)).toEqual({
      date: "2027-02-01",
      balance: 1300,
      projected: null,
    })
    // the projection still shows today; the post-horizon actual is a tail
    expect(rows.some((row) => row.projected === 1005)).toBe(true)
  })

  it("history-less users render the dashed projection alone", () => {
    const rows = mergeBalance(
      [],
      prediction([
        projectionPoint("2026-10-27", 100_000),
        projectionPoint("2026-11-01", 101_000),
      ])
    )
    expect(rows).toEqual([
      { date: "2026-10-27", balance: null, projected: 1000 },
      { date: "2026-11-01", balance: null, projected: 1010 },
    ])
  })
})
