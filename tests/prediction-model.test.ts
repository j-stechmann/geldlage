import { describe, it, expect } from "vitest"
import { isoDatePlus } from "@/lib/dates"
import {
  artifactTier,
  featureNames,
  featureTier,
  predictDirection,
  trainDailyModel,
} from "@/lib/prediction/model"
import type { DailySeriesPoint } from "@/lib/prediction/types"

function series(days: number): DailySeriesPoint[] {
  const points: DailySeriesPoint[] = []
  const start = "2026-01-01"
  for (let i = 0; i < days; i++) {
    const date = isoDatePlus(start, i)
    const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay()
    // deterministic irregular pattern: weekly groceries, a monthly bill,
    // zero days, and a small salary twice a month
    const grocery = weekday === 2 || weekday === 5 ? 4200 + (i % 4) * 350 : 0
    const bill = i % 30 === 0 ? 18000 : 0
    const salary = i % 15 === 0 ? 250000 : 0
    points.push({
      date,
      expenseCents: grocery + bill + (i % 7 === 0 ? 900 : 0),
      incomeCents: salary,
    })
  }
  return points
}

function data(points: DailySeriesPoint[]) {
  return {
    from: points[0].date,
    to: points[points.length - 1].date,
    days: points.length,
    transactionCount: points.length,
    planSignature: "plans",
    dataSignature: "data",
  }
}

describe("daily prediction model", () => {
  it("uses a tiered feature set so one month does not overfit", () => {
    expect(featureTier(28)).toBe(0)
    expect(featureTier(59)).toBe(0)
    expect(featureTier(60)).toBe(1)
    expect(featureTier(180)).toBe(2)
    expect(featureNames(0).length).toBeLessThan(featureNames(1).length)
    expect(featureNames(1).length).toBeLessThan(featureNames(2).length)
  })

  it("trains deterministically and chooses a valid algorithm per direction", () => {
    const points = series(120)
    const first = trainDailyModel(
      points,
      data(points),
      new Date("2026-04-30T12:00:00Z")
    )
    const second = trainDailyModel(
      points,
      data(points),
      new Date("2026-04-30T12:00:00Z")
    )
    expect(second).toEqual(first)
    expect(["tweedie-daily-v1", "baseline"]).toContain(first.expense.algorithm)
    expect(["tweedie-daily-v1", "baseline"]).toContain(first.income.algorithm)
    expect(first.data.days).toBe(points.length)
    expect(artifactTier(first)).toBe(1)
  })

  it("predicts non-negative daily values recursively for any horizon", () => {
    const points = series(90)
    const artifact = trainDailyModel(
      points,
      data(points),
      new Date("2026-03-31T12:00:00Z")
    )
    const history = [...points]
    for (let i = 0; i < 60; i++) {
      const date = isoDatePlus(points[points.length - 1].date, i + 1)
      const expense = predictDirection(artifact, "expense", history, date)
      const income = predictDirection(artifact, "income", history, date)
      expect(expense).toBeGreaterThanOrEqual(0)
      expect(income).toBeGreaterThanOrEqual(0)
      expect(Number.isSafeInteger(expense)).toBe(true)
      expect(Number.isSafeInteger(income)).toBe(true)
      history.push({
        date,
        expenseCents: expense,
        incomeCents: income,
      })
    }
  })

  it("keeps the stored baseline rate across a zero-spend import gap", () => {
    const points = series(28)
    const artifact = trainDailyModel(
      points,
      data(points),
      new Date("2026-01-28T12:00:00Z")
    )
    const zeros = Array.from({ length: 30 }, (_, i) => ({
      date: isoDatePlus("2026-02-01", i),
      expenseCents: 0,
      incomeCents: 0,
    }))
    const baselineArtifact = {
      ...artifact,
      expense: { ...artifact.expense, algorithm: "baseline" as const },
    }
    expect(
      predictDirection(baselineArtifact, "expense", zeros, "2026-03-15")
    ).toBe(Math.round(baselineArtifact.expense.baselineRateCents))
  })

  it("trains with exactly one month of history", () => {
    const points = series(28)
    const artifact = trainDailyModel(
      points,
      data(points),
      new Date("2026-01-28T12:00:00Z")
    )
    expect(artifact.data.days).toBe(28)
    expect(["tweedie-daily-v1", "baseline"]).toContain(
      artifact.expense.algorithm
    )
    expect(["tweedie-daily-v1", "baseline"]).toContain(
      artifact.income.algorithm
    )
  })

  it("does not mutate the source series", () => {
    const points = series(45)
    const snapshot = JSON.stringify(points)
    trainDailyModel(points, data(points), new Date("2026-02-14T12:00:00Z"))
    expect(JSON.stringify(points)).toBe(snapshot)
  })
})
