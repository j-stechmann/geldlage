import { describe, it, expect } from "vitest"
import {
  errorMetrics,
  fitTweedie,
  fitWeightedRidge,
  predictStandardized,
  tweediePredict,
} from "@/lib/prediction/math"

describe("prediction math", () => {
  it("recovers a simple weighted-ridge line", () => {
    const X = Array.from({ length: 20 }, (_, i) => [1, i])
    const y = X.map(([, x]) => 3 + 2 * x)
    const model = fitWeightedRidge(X, y, new Array(X.length).fill(1), 0.0001)
    for (const x of [0, 5, 19]) {
      expect(predictStandardized(model, [1, x])).toBeCloseTo(3 + 2 * x, 3)
    }
  })

  it("shrinks slopes as the ridge penalty grows", () => {
    const X = Array.from({ length: 10 }, (_, i) => [1, i])
    const y = X.map(([, x]) => 5 * x + (x % 2 === 0 ? 4 : -4))
    const weak = fitWeightedRidge(X, y, new Array(X.length).fill(1), 0.001)
    const strong = fitWeightedRidge(X, y, new Array(X.length).fill(1), 100)
    expect(Math.abs(strong.beta[1])).toBeLessThan(Math.abs(weak.beta[1]))
  })

  it("fits a non-negative Tweedie daily rate", () => {
    const X = Array.from({ length: 40 }, (_, i) => [1, i % 7, i % 2])
    const y = X.map(([, weekday, odd]) =>
      weekday === 0 ? 0 : 100 + weekday * 10 + odd * 5
    )
    const model = fitTweedie(X, y, new Array(X.length).fill(1), 10, 1.5)
    for (const row of X) {
      expect(tweediePredict(model, row)).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(tweediePredict(model, row))).toBe(true)
    }
  })

  it("handles all-zero targets without NaN", () => {
    const X = Array.from({ length: 30 }, (_, i) => [1, i % 7])
    const model = fitTweedie(
      X,
      new Array(X.length).fill(0),
      new Array(X.length).fill(1),
      1,
      1.5
    )
    expect(Number.isFinite(tweediePredict(model, [1, 3]))).toBe(true)
    expect(tweediePredict(model, [1, 3])).toBeGreaterThanOrEqual(0)
  })

  it("computes error metrics with a null WAPE when actuals are zero", () => {
    expect(errorMetrics([0, 0], [1, 2]).wape).toBeNull()
    expect(errorMetrics([10, 20], [8, 24])).toMatchObject({
      mae: 3,
      wape: 0.2,
      bias: -1,
    })
  })
})
