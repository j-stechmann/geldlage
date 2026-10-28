import { describe, it, expect } from "vitest"
import {
  topCategoriesMerge,
  topCategoriesTooltip,
  type TopCategoryRow,
} from "@/components/analytics-charts"
import type { ForecastResult } from "@/components/planning/api"

/**
 * Merge-identity regression (planned-vs-actual Top-Ausgabenkategorien): the
 * merge used to write the planned sums into the memoized Ist rows IN PLACE —
 * with the forecast toggle off (merged === chartData) that stale planned
 * value kept printing " + X € geplant" in tooltips until the next analytics
 * refetch. The merge must copy, and stacking by CATEGORY ID (null == null)
 * must not split "Unlabeled"/"ohne Kategorie" into twin rows.
 */

function istRow(over: Partial<TopCategoryRow> = {}): TopCategoryRow {
  return {
    categoryId: 1,
    name: "Miete",
    value: 100,
    planned: 0,
    share: 0.5,
    fill: "#ff0000",
    ...over,
  }
}

type PlannedCategory = ForecastResult["plannedCategories"][number]

function plannedEntry(over: Partial<PlannedCategory> = {}): PlannedCategory {
  return {
    categoryId: 1,
    name: "Miete",
    color: "#ff0000",
    totalCents: 20_000,
    share: 0.25,
    ...over,
  }
}

function forecast(plannedCategories: PlannedCategory[]): ForecastResult {
  return {
    startingBalanceCents: 0,
    withoutSnapshot: false,
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2027-10-31" },
    monthlyPlanned: [],
    projectedBalance: [],
    plannedCategories,
  }
}

describe("topCategoriesMerge", () => {
  it("returns the Ist rows untouched when the forecast is off", () => {
    const chartData = [
      istRow(),
      istRow({ categoryId: null, name: "Unlabeled" }),
    ]
    expect(topCategoriesMerge(chartData, undefined)).toBe(chartData)
  })

  it("never mutates the memoized Ist rows (stale-planned tooltip regression)", () => {
    const chartData = [istRow()]
    const merged = topCategoriesMerge(chartData, forecast([plannedEntry()]))
    expect(merged[0].planned).toBe(200)
    // toggle-off readout: with the forecast off the tooltip must not print a
    // planned supplement — this stays correct only while chartData's
    // planned field is untouched by the merge
    expect(chartData[0].planned).toBe(0)
    expect(topCategoriesTooltip(100, "value", { payload: chartData[0] })).toBe(
      "100,00 € (50 %)"
    )
  })

  it("stacks planned money onto the matching category id bucket (null == null)", () => {
    const chartData = [istRow({ categoryId: null, name: "Unlabeled" })]
    const merged = topCategoriesMerge(
      chartData,
      forecast([plannedEntry({ categoryId: null, name: "ohne Kategorie" })])
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].name).toBe("Unlabeled")
    expect(merged[0].value).toBe(100)
    expect(merged[0].planned).toBe(200)
  })

  it("appends planned-only rows with the horizon share and sorts by combined total", () => {
    const chartData = [istRow({ value: 10 })]
    const merged = topCategoriesMerge(
      chartData,
      forecast([
        plannedEntry({
          categoryId: null,
          name: "ohne Kategorie",
          totalCents: 50_000,
          share: 0.75,
        }),
      ])
    )
    expect(merged.map((r) => r.name)).toEqual(["ohne Kategorie", "Miete"])
    expect(merged[0].value).toBe(0)
    expect(merged[0].planned).toBe(500)
    expect(merged[0].share).toBe(0.75)
  })

  it("caps the merged rows at 12", () => {
    const planned = Array.from({ length: 15 }, (_, i) =>
      plannedEntry({
        categoryId: i + 1,
        name: `Kat ${i + 1}`,
        totalCents: 1000 - i,
      })
    )
    expect(topCategoriesMerge([], forecast(planned))).toHaveLength(12)
  })

  it("carries planned: undefined on rows without planned money (0,00 € geplant rows omitted)", () => {
    const merged = topCategoriesMerge(
      [istRow()],
      forecast([plannedEntry({ categoryId: 2, name: "Andere" })])
    )
    const ohnePlan = merged.find((r) => r.name === "Miete")
    expect(ohnePlan?.planned).toBeUndefined()
    // unchanged Ist readout — no planned supplement, Ist share intact
    expect(topCategoriesTooltip(100, "value", { payload: ohnePlan })).toBe(
      "100,00 € (50 %)"
    )
  })

  it("same-named categories stay distinct identities (the Cell keys render without collisions)", () => {
    // two user-created categories sharing a display name must remain two rows
    // with distinct ids — the planned-vs-actual chart keys its per-row
    // <Cell> fill on this identity, so a name-keyed identity would render
    // duplicate React keys (and the rows themselves would be indistinguishable)
    const chartData = [
      istRow({ categoryId: 1, name: "Versicherung", value: 50 }),
      istRow({ categoryId: 2, name: "Versicherung", value: 70 }),
    ]
    const merged = topCategoriesMerge(
      chartData,
      forecast([
        plannedEntry({ categoryId: 2, name: "Versicherung", totalCents: 40_000 }),
        plannedEntry({
          categoryId: null,
          name: "ohne Kategorie",
          totalCents: 10_000,
        }),
      ])
    )
    const versicherungen = merged.filter((r) => r.name === "Versicherung")
    expect(versicherungen).toHaveLength(2)
    // planned money stacked onto the right one of the two same-named rows
    expect(versicherungen.find((r) => r.categoryId === 1)?.planned).toBeUndefined()
    expect(versicherungen.find((r) => r.categoryId === 2)?.planned).toBe(400)
    // ids stay pairwise distinct across ALL rows — what the Cell keys are
    expect(new Set(merged.map((r) => String(r.categoryId))).size).toBe(
      merged.length
    )
  })
})
