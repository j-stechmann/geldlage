import { describe, it, expect } from "vitest"
import {
  topCategoryAxisLabels,
  topCategoryAxisMinGap,
  topCategoryAxisTickCount,
  topCategoryAxisTicks,
} from "@/components/analytics-charts"

/**
 * X-axis regression (Top-Ausgabenkategorien): the euro axis is visible, snaps
 * to whole-euro 1/2/2.5/5 × 10ⁿ candidates and ends on the largest category
 * (the domain is pinned to it so the bars keep their full width). Percent
 * shares are a second-line readout while the axis is Ist-only, never a second
 * percentage scale.
 */

describe("topCategoryAxisLabels", () => {
  it("stacks the euro value and its Ist-period share", () => {
    expect(topCategoryAxisLabels(0, 2000)).toEqual({
      euro: "0 €",
      share: "0 %",
    })
    expect(topCategoryAxisLabels(500, 2000)).toEqual({
      euro: "500 €",
      share: "25 %",
    })
    expect(topCategoryAxisLabels(1500, 3000)).toEqual({
      euro: "1.500 €",
      share: "50 %",
    })
    expect(topCategoryAxisLabels(2000, 2000)).toEqual({
      euro: "2.000 €",
      share: "100 %",
    })
  })

  it("rounds the share to whole points", () => {
    expect(topCategoryAxisLabels(333, 1000)).toEqual({
      euro: "333 €",
      share: "33 %",
    })
  })

  it("never prints a false 0 % or 100 %", () => {
    // 20 € of 10.000 € rounds to 0 %, but the tick is not zero money
    expect(topCategoryAxisLabels(20, 10_000)).toEqual({
      euro: "20 €",
      share: "<1 %",
    })
    // 9.996 € of 10.000 € rounds to 100 %, but the total is still off-chart
    expect(topCategoryAxisLabels(9996, 10_000)).toEqual({
      euro: "9.996 €",
      share: ">99 %",
    })
    // the zero tick genuinely is 0 % of the total
    expect(topCategoryAxisLabels(0, 10_000)).toEqual({
      euro: "0 €",
      share: "0 %",
    })
  })

  it("drops the share without an Ist denominator", () => {
    expect(topCategoryAxisLabels(500, 0)).toEqual({
      euro: "500 €",
      share: undefined,
    })
    expect(topCategoryAxisLabels(0, 0)).toEqual({
      euro: "0 €",
      share: undefined,
    })
  })
})

describe("topCategoryAxisTickCount", () => {
  it("fits fewer ticks into a narrow card and caps wide cards", () => {
    // plot width = chart width - 120px Y axis - 5/40px margins
    expect(topCategoryAxisTickCount(320, 2437)).toBe(4)
    expect(topCategoryAxisTickCount(272, 2437)).toBe(3)
    expect(topCategoryAxisTickCount(600, 2437)).toBe(6)
    expect(topCategoryAxisTickCount(1200, 2437)).toBe(6)
  })

  it("reserves more room for long euro labels", () => {
    // "1.000.000 €" is wider than "2.437 €"
    expect(topCategoryAxisTickCount(400, 1_000_000)).toBe(4)
    expect(topCategoryAxisTickCount(400, 1_000_000_000)).toBe(3)
  })

  it("keeps at least two ticks and degrades without a measured width", () => {
    for (const width of [0, -20, 50, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(topCategoryAxisTickCount(width, 2437)).toBe(2)
    }
  })
})

describe("topCategoryAxisMinGap", () => {
  it("grows with the data maximum and shrinks as the plot widens", () => {
    expect(topCategoryAxisMinGap(0, 320)).toBe(0)
    expect(topCategoryAxisMinGap(2437, 320)).toBeGreaterThan(0)
    expect(topCategoryAxisMinGap(2437, 320)).toBeGreaterThan(
      topCategoryAxisMinGap(2437, 600)
    )
    expect(topCategoryAxisMinGap(1_000_000, 320)).toBeGreaterThan(
      topCategoryAxisMinGap(2437, 320)
    )
  })
})

describe("topCategoryAxisTicks", () => {
  it("snaps the grid to round euro steps instead of arbitrary fractions", () => {
    expect(topCategoryAxisTicks(2437)).toEqual([0, 500, 1000, 1500, 2000, 2437])
    expect(topCategoryAxisTicks(1234)).toEqual([0, 250, 500, 750, 1000, 1234])
    expect(topCategoryAxisTicks(600)).toEqual([0, 200, 400, 600])
    expect(topCategoryAxisTicks(50)).toEqual([0, 10, 20, 30, 40, 50])
  })

  it("coarsens the ladder instead of thinning it when the card is narrow", () => {
    // four-slot ladder before the collision guard: 0, 1.000, 2.000 + max
    expect(topCategoryAxisTicks(2437, 4)).toEqual([0, 1000, 2000, 2437])
    expect(topCategoryAxisTicks(2437, 3)).toEqual([0, 2000, 2437])
    expect(topCategoryAxisTicks(2437, 2)).toEqual([0, 2437])
    expect(topCategoryAxisTicks(2437, 1)).toEqual([0, 2437])
  })

  it("drops a round tick the appended maximum would collide with", () => {
    // a 323 € centre gap is one 1.001 € label wide at ~155px of plot
    expect(topCategoryAxisTicks(1000.5, 4, 323)).toEqual([0, 500, 1000.5])
    expect(topCategoryAxisTicks(2100, 4, 677)).toEqual([0, 1000, 2100])
    // a max that is already far enough keeps its regular predecessor
    expect(topCategoryAxisTicks(2437, 4, 300)).toEqual([0, 1000, 2000, 2437])
  })

  it("keeps every gap at least a label apart at real card widths", () => {
    for (const width of [272, 320, 400, 600]) {
      for (const max of [
        1000.5, 1001, 1200.1, 1500.6, 2001, 2100, 2437, 2437.42, 28_800,
        1_000_000,
      ]) {
        const gap = topCategoryAxisMinGap(max, width)
        const ticks = topCategoryAxisTicks(
          max,
          topCategoryAxisTickCount(width, max),
          gap
        )
        for (let i = 1; i < ticks.length; i++) {
          expect(ticks[i] - ticks[i - 1]).toBeGreaterThanOrEqual(gap - 1e-9)
        }
      }
    }
  })

  it("shows only the origin when even two labels cannot fit", () => {
    expect(topCategoryAxisTicks(100, 2, 109)).toEqual([0])
    // a trillion-euro max has a label wider than a 107px plot
    expect(
      topCategoryAxisTicks(
        1_000_000_000_000,
        2,
        topCategoryAxisMinGap(1_000_000_000_000, 272)
      )
    ).toEqual([0])
  })

  it("never lets an absurd tick cap build an unbounded ladder", () => {
    for (const cap of [Infinity, Number.NaN, 1e9]) {
      expect(topCategoryAxisTicks(2437, cap).length).toBeLessThanOrEqual(6)
    }
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
