// @vitest-environment jsdom
/**
 * Visibility regression for the Top-Ausgabenkategorien x-axis. The axis used
 * to be `<XAxis hide />`, which the pure tick-helper tests cannot catch: they
 * would stay green if the axis were hidden again. Stubbing recharts keeps the
 * assertion on the props the component actually passes (a real jsdom mount
 * has no measurable layout), including the right margin that keeps the last
 * tick label inside the SVG.
 */
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { TopCategoriesChart } from "@/components/analytics-charts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import type { ForecastResult } from "@/components/planning/api"

const captured = vi.hoisted(() => ({
  xAxis: [] as Array<Record<string, unknown>>,
  barChart: [] as Array<Record<string, unknown>>,
}))

vi.mock("recharts", async () => {
  const React = await import("react")
  const Box = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children)
  const Empty = () => null
  const XAxis = (props: Record<string, unknown>) => {
    captured.xAxis.push(props)
    return null
  }
  const BarChart = (props: Record<string, unknown>) => {
    captured.barChart.push(props)
    return React.createElement("div", null, props.children as ReactNode)
  }
  return {
    Bar: Box,
    BarChart,
    CartesianGrid: Empty,
    Cell: Empty,
    ComposedChart: Box,
    Legend: Empty,
    Line: Empty,
    LineChart: Box,
    ResponsiveContainer: Box,
    Tooltip: Empty,
    XAxis,
    YAxis: Empty,
  }
})

type CategoryRow = AnalyticsResponse["topCategories"][number]

function category(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    categoryId: 1,
    name: "Miete",
    color: null,
    totalCents: 243700,
    share: 0.5,
    txCount: 1,
    ...overrides,
  }
}

const DATA: AnalyticsResponse["topCategories"] = [
  category(),
  category({
    categoryId: 2,
    name: "Essen",
    totalCents: 50000,
    share: 0.1,
    txCount: 2,
  }),
]

const FORECAST = {
  plannedCategories: [
    {
      categoryId: 1,
      name: "Miete",
      color: null,
      totalCents: 100000,
      share: 0.4,
    },
  ],
} as unknown as ForecastResult

beforeEach(() => {
  captured.xAxis.length = 0
  captured.barChart.length = 0
})
afterEach(cleanup)

describe("TopCategoriesChart x-axis", () => {
  it("renders a visible number axis ending on the largest category", () => {
    render(<TopCategoriesChart data={DATA} loading={false} />)
    const props = captured.xAxis[0]
    expect(props.type).toBe("number")
    expect(props.hide).toBeUndefined()
    expect(props.domain).toEqual([0, 2437])
    expect(props.ticks).toEqual([0, 500, 1000, 1500, 2000, 2437])
    const format = props.tickFormatter as (v: number) => string
    expect(format(1500)).toBe("1.500 €")
  })

  it("reserves room for the last tick label at the right edge", () => {
    render(<TopCategoriesChart data={DATA} loading={false} />)
    expect(captured.barChart[0].margin).toEqual({
      top: 5,
      right: 40,
      bottom: 5,
      left: 5,
    })
  })

  it("includes the planned stack in the domain while the overlay is on", () => {
    render(
      <TopCategoriesChart data={DATA} forecast={FORECAST} loading={false} />
    )
    const props = captured.xAxis[0]
    // Miete: 2.437 € Ist + 1.000 € geplant
    expect(props.domain).toEqual([0, 3437])
    expect((props.ticks as number[]).at(-1)).toBe(3437)
  })

  it("renders a planned-only dataset instead of the empty state", () => {
    const plannedOnly = {
      plannedCategories: [
        {
          categoryId: 3,
          name: "Urlaub",
          color: null,
          totalCents: 250000,
          share: 1,
        },
      ],
    } as unknown as ForecastResult
    render(
      <TopCategoriesChart data={[]} forecast={plannedOnly} loading={false} />
    )
    const props = captured.xAxis[0]
    expect(props.domain).toEqual([0, 2500])
    expect((props.ticks as number[]).at(-1)).toBe(2500)
  })

  it("shows the empty state instead of a zero-width axis without money", () => {
    render(<TopCategoriesChart data={[]} loading={false} />)
    expect(captured.xAxis).toHaveLength(0)
    expect(
      screen.getByText("Keine Ausgaben im gewählten Zeitraum.")
    ).toBeTruthy()
    cleanup()
    render(
      <TopCategoriesChart
        data={[category({ totalCents: 0, share: 0 })]}
        loading={false}
      />
    )
    expect(captured.xAxis).toHaveLength(0)
  })
})
