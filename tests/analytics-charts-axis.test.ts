import { describe, it, expect } from "vitest"
import { topCategoryAxisTicks } from "@/components/analytics-charts"

/**
 * X-axis regression (Top-Ausgabenkategorien): the euro axis is visible, snaps
 * to whole-euro 1/2/2.5/5 × 10ⁿ steps and ends on the largest category (the
 * domain is pinned to it so the bars keep their full width). Percent shares
 * are tooltip-only — a single euro scale is what the axis must carry.
 */

describe("topCategoryAxisTicks", () => {
  it("snaps the grid to round euro steps instead of arbitrary fractions", () => {
    expect(topCategoryAxisTicks(2437)).toEqual([0, 500, 1000, 1500, 2000, 2437])
    expect(topCategoryAxisTicks(1234)).toEqual([0, 250, 500, 750, 1000, 1234])
    expect(topCategoryAxisTicks(600)).toEqual([0, 200, 400, 600])
    expect(topCategoryAxisTicks(50)).toEqual([0, 10, 20, 30, 40, 50])
  })

  it("rounds a fractional candidate step up to whole euros", () => {
    // 12 / 5 = 2.4 → 2.5 candidate, ceiled to 3 so the rounded labels differ
    expect(topCategoryAxisTicks(12)).toEqual([0, 3, 6, 9, 12])
  })

  it("ends the axis on the data maximum so the longest bar has a label", () => {
    for (const max of [2437, 1234, 999, 600, 1499, 1400, 12, 3.7, 28800]) {
      const ticks = topCategoryAxisTicks(max)
      expect(ticks[ticks.length - 1]).toBe(max)
    }
  })

  it("keeps the grid strictly increasing and inside the domain", () => {
    for (const max of [
      2437, 1234, 999, 600, 1499, 1400, 12, 3.7, 28800, 1_000_000,
    ]) {
      const ticks = topCategoryAxisTicks(max)
      expect(ticks[0]).toBe(0)
      expect(Math.max(...ticks)).toBe(max)
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1])
      }
    }
  })

  it("uses whole-euro intermediate ticks; only the appended max may have cents", () => {
    const ticks = topCategoryAxisTicks(2437.42)
    expect(ticks.slice(0, -1).every(Number.isInteger)).toBe(true)
    expect(ticks[ticks.length - 1]).toBe(2437.42)
  })

  it("never prints duplicate rounded labels", () => {
    for (const max of [
      2437, 1234, 600, 1499, 1400, 12, 3.7, 28800, 1.2, 1.5, 2.4,
    ]) {
      const labels = topCategoryAxisTicks(max).map((v) =>
        Math.round(v).toLocaleString("de-DE")
      )
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  it("stays increasing with unique labels across realistic cent values", () => {
    for (let cents = 100; cents <= 5_000_000; cents += 7919) {
      const max = cents / 100
      const ticks = topCategoryAxisTicks(max)
      expect(ticks[0]).toBe(0)
      // the raw max is appended whenever its rounded label is distinct;
      // otherwise the last tick rounds to the same label as the max
      expect(
        ticks[ticks.length - 1] === max ||
          Math.round(ticks[ticks.length - 1]) === Math.round(max)
      ).toBe(true)
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1])
      }
      const labels = ticks.map((v) => Math.round(v).toLocaleString("de-DE"))
      expect(new Set(labels).size).toBe(labels.length)
      expect(ticks.length).toBeLessThanOrEqual(20)
    }
  })

  it("degrades to a single zero tick without a usable euro domain", () => {
    for (const max of [
      0,
      -5,
      0.5,
      0.99,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MIN_VALUE,
    ]) {
      expect(topCategoryAxisTicks(max)).toEqual([0])
    }
  })
})
