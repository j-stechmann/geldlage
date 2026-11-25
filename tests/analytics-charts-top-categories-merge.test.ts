import { describe, it, expect } from "vitest"
import {
  topCategoriesMerge,
  topCategoriesTooltip,
  type TopCategoryRow,
} from "@/components/analytics-charts"
import type { PredictionForecast } from "@/lib/contracts/prediction"

/**
 * Merge-identity regression for the Ist-vs-Prognose categories chart: the
 * merge must copy the memoized Ist rows, and stack by CATEGORY ID
 * (null == null) so "Unlabeled"/"ohne Kategorie" cannot split into twins.
 */

function istRow(over: Partial<TopCategoryRow> = {}): TopCategoryRow {
  return {
    categoryId: 1,
    name: "Miete",
    value: 100,
    predicted: 0,
    share: 0.5,
    fill: "#ff0000",
    ...over,
  }
}

function prediction(
  categories: PredictionForecast["monthly"][number]["categories"]
): PredictionForecast {
  return {
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2026-12-31", months: 2 },
    startingBalanceCents: 0,
    withoutSnapshot: false,
    daily: [],
    monthly: [
      {
        month: "2026-11",
        partial: false,
        incomeCents: 0,
        expensesCents: 20_000,
        netCents: -20_000,
        bookedFuture: { incomeCents: 0, expensesCents: 0 },
        categories,
      },
    ],
    projectedBalance: [],
    source: "model",
    pending: false,
    retryAt: null,
  }
}

describe("topCategoriesMerge", () => {
  it("returns the Ist rows untouched without a prediction", () => {
    const chartData = [
      istRow(),
      istRow({ categoryId: null, name: "Unlabeled" }),
    ]
    expect(topCategoriesMerge(chartData, undefined)).toBe(chartData)
  })

  it("never mutates the memoized Ist rows", () => {
    const chartData = [istRow()]
    const merged = topCategoriesMerge(
      chartData,
      prediction([
        {
          categoryId: 1,
          name: "Miete",
          color: "#ff0000",
          expensesCents: 20_000,
        },
      ])
    )
    expect(merged[0].predicted).toBe(200)
    expect(chartData[0].predicted).toBe(0)
    expect(topCategoriesTooltip(100, "value", { payload: chartData[0] })).toBe(
      "100,00 € (50 % der Ist-Ausgaben)"
    )
  })

  it("stacks predicted money onto the matching category id (null == null)", () => {
    const chartData = [istRow({ categoryId: null, name: "Unlabeled" })]
    const merged = topCategoriesMerge(
      chartData,
      prediction([
        {
          categoryId: null,
          name: "ohne Kategorie",
          color: null,
          expensesCents: 20_000,
        },
      ])
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].name).toBe("Unlabeled")
    expect(merged[0].value).toBe(100)
    expect(merged[0].predicted).toBe(200)
  })

  it("appends prediction-only rows with the horizon share and sorts by total", () => {
    const merged = topCategoriesMerge(
      [istRow({ value: 10 })],
      prediction([
        {
          categoryId: null,
          name: "ohne Kategorie",
          color: null,
          expensesCents: 50_000,
        },
      ])
    )
    expect(merged.map((r) => r.name)).toEqual(["ohne Kategorie", "Miete"])
    expect(merged[0].value).toBe(0)
    expect(merged[0].predicted).toBe(500)
    expect(merged[0].share).toBeCloseTo(1)
  })

  it("caps merged rows at 12", () => {
    const categories = Array.from({ length: 15 }, (_, i) => ({
      categoryId: i + 1,
      name: `Kat ${i + 1}`,
      color: null,
      expensesCents: 1000 - i,
    }))
    expect(topCategoriesMerge([], prediction(categories))).toHaveLength(12)
  })

  it("rows without predicted money carry predicted: undefined", () => {
    const merged = topCategoriesMerge(
      [istRow()],
      prediction([
        {
          categoryId: 2,
          name: "Andere",
          color: "#00ff00",
          expensesCents: 20_000,
        },
      ])
    )
    const miete = merged.find((r) => r.name === "Miete")
    expect(miete?.predicted).toBeUndefined()
    expect(topCategoriesTooltip(100, "value", { payload: miete })).toBe(
      "100,00 € (50 % der Ist-Ausgaben)"
    )
  })

  it("same-named categories stay distinct identities", () => {
    const chartData = [
      istRow({ categoryId: 1, name: "Versicherung", value: 50 }),
      istRow({ categoryId: 2, name: "Versicherung", value: 70 }),
    ]
    const merged = topCategoriesMerge(
      chartData,
      prediction([
        {
          categoryId: 2,
          name: "Versicherung",
          color: null,
          expensesCents: 40_000,
        },
        {
          categoryId: null,
          name: "ohne Kategorie",
          color: null,
          expensesCents: 10_000,
        },
      ])
    )
    const versicherungen = merged.filter((r) => r.name === "Versicherung")
    expect(versicherungen).toHaveLength(2)
    expect(
      versicherungen.find((r) => r.categoryId === 1)?.predicted
    ).toBeUndefined()
    expect(versicherungen.find((r) => r.categoryId === 2)?.predicted).toBe(400)
    expect(new Set(merged.map((r) => String(r.categoryId))).size).toBe(
      merged.length
    )
  })
})
