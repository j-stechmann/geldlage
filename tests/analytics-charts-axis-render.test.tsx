// @vitest-environment jsdom
/**
 * Visibility regression for the Top-Ausgabenkategorien x-axis. The axis used
 * to be `<XAxis hide />`, which the pure tick-helper tests cannot catch: they
 * would stay green if the axis were hidden again. Stubbing recharts keeps the
 * assertion on the props the component actually passes (a real jsdom mount
 * has no measurable layout), including the right margin that keeps the last
 * tick label inside the SVG.
 */
import { type ReactElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { TopCategoriesChart } from "@/components/analytics-charts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import type { ForecastResult } from "@/components/planning/api"

const captured = vi.hoisted(() => ({
  xAxis: [] as Array<Record<string, unknown>>,
  yAxis: [] as Array<Record<string, unknown>>,
  barChart: [] as Array<Record<string, unknown>>,
  tooltip: [] as Array<Record<string, unknown>>,
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
  const YAxis = (props: Record<string, unknown>) => {
    captured.yAxis.push(props)
    return null
  }
  const BarChart = (props: Record<string, unknown>) => {
    captured.barChart.push(props)
    return React.createElement("div", null, props.children as ReactNode)
  }
  const Tooltip = (props: Record<string, unknown>) => {
    captured.tooltip.push(props)
    return null
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
    Tooltip,
    XAxis,
    YAxis,
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
  // a zero-share row first pins the "skip rows without money" search
  category({
    categoryId: 9,
    name: "Leer",
    totalCents: 0,
    share: 0,
    txCount: 0,
  }),
  category(),
  category({
    categoryId: 2,
    name: "Essen",
    totalCents: 50000,
    // consistent with the 4.874 € denominator recovered from the Miete row
    share: 50000 / 487400,
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
  captured.yAxis.length = 0
  captured.barChart.length = 0
  captured.tooltip.length = 0
})
afterEach(cleanup)

describe("TopCategoriesChart x-axis", () => {
  it("renders a visible number axis ending on the largest category", () => {
    render(<TopCategoriesChart data={DATA} loading={false} />)
    const props = captured.xAxis[0]
    expect(props.type).toBe("number")
    expect(props.hide).toBeUndefined()
    // the explicit domain must win over Recharts' adaptive nice ticks, or
    // the bars no longer fill the [0, max] width
    expect(props.niceTicks).toBe("none")
    expect(props.domain).toEqual([0, 2437])
    expect(props.ticks).toEqual([0, 500, 1000, 1500, 2000, 2437])
    const format = props.tickFormatter as (v: number) => string
    expect(format(1500)).toBe("1.500 €")
    expect(props.height).toBe(44)
    expect(typeof props.tick).toBe("function")
  })

  it("renders the euro value and the Ist share on two tick lines", () => {
    render(<TopCategoriesChart data={DATA} loading={false} />)
    const tick = captured.xAxis[0].tick as (
      props: Record<string, unknown>
    ) => ReactElement
    const { container } = render(
      tick({
        x: 0,
        y: 0,
        payload: { value: 1500 },
        textAnchor: "middle",
        fill: "#666",
      })
    )
    // DATA recovers a 4.874 € Ist total; a 5.000 € denominator would print
    // 30 %, so this pins the actual API denominator
    expect(container.textContent).toContain("1.500 €")
    expect(container.textContent).toContain("31 %")
    // the second line is what keeps the label narrow — assert the stacking,
    // not just the concatenated text
    const tspans = container.querySelectorAll("text tspan")
    expect(tspans).toHaveLength(2)
    expect(tspans[1].getAttribute("dy")).toBe("14")
    // themed fill for WCAG contrast in dark mode
    expect(container.querySelector("text")?.getAttribute("fill")).toBe(
      "var(--muted-foreground)"
    )
    expect(container.querySelector("text")?.getAttribute("aria-label")).toBe(
      "1.500 €, 31 % der Ist-Ausgaben"
    )
  })

  it("omits the share line while the forecast overlay is on", () => {
    render(
      <TopCategoriesChart data={DATA} forecast={FORECAST} loading={false} />
    )
    const props = captured.xAxis[0]
    // the height stays at the two-line size while Ist data exists, so
    // loading the overlay cannot reflow the bars
    expect(props.height).toBe(44)
    const tick = props.tick as (props: Record<string, unknown>) => ReactElement
    const { container } = render(
      tick({
        x: 0,
        y: 0,
        payload: { value: 500 },
        textAnchor: "middle",
        fill: "#666",
      })
    )
    expect(container.textContent).toBe("500 €")
    expect(container.querySelectorAll("text tspan")).toHaveLength(1)
  })

  it("keeps the share line when the overlay has no planned expenses", () => {
    const emptyForecast = {
      plannedCategories: [],
    } as unknown as ForecastResult
    render(
      <TopCategoriesChart
        data={DATA}
        forecast={emptyForecast}
        loading={false}
      />
    )
    const props = captured.xAxis[0]
    expect(props.height).toBe(44)
    const tick = props.tick as (props: Record<string, unknown>) => ReactElement
    const { container } = render(
      tick({
        x: 0,
        y: 0,
        payload: { value: 500 },
        textAnchor: "middle",
        fill: "#666",
      })
    )
    expect(container.textContent).toContain("10 %")
  })

  it("forces every category label despite the visible x axis", () => {
    render(<TopCategoriesChart data={DATA} loading={false} />)
    // the visible XAxis costs 30-44px of plot height; Recharts' default
    // preserveEnd then drops every other Y label, so interval=0 is required
    expect(captured.yAxis[0]).toMatchObject({
      dataKey: "name",
      type: "category",
      interval: 0,
      tick: { fill: "var(--muted-foreground)" },
    })
  })

  it("reserves room for the last tick label at the right edge", () => {
    render(<TopCategoriesChart data={DATA} loading={false} />)
    expect(captured.barChart[0].margin).toMatchObject({ right: 40 })
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
    // no Ist denominator exists here: the axis is single-line (30 px) and
    // the planned-only bar never grows a share line
    expect(props.height).toBe(30)
    const tick = props.tick as (props: Record<string, unknown>) => ReactElement
    const { container } = render(
      tick({
        x: 0,
        y: 0,
        payload: { value: 500 },
        textAnchor: "middle",
        fill: "#666",
      })
    )
    expect(container.textContent).toBe("500 €")
  })

  it("wires the tooltip formatter to the share-basis helper", () => {
    render(<TopCategoriesChart data={DATA} loading={false} />)
    const content = captured.tooltip[0].content as ReactElement<{
      formatter: (
        value: unknown,
        name: unknown,
        item: { payload?: Record<string, unknown> }
      ) => string
    }>
    expect(typeof content.props.formatter).toBe("function")
    expect(
      content.props.formatter(500, "value", {
        payload: { value: 500, share: 0.5 },
      })
    ).toBe("500,00 € (50 % der Ist-Ausgaben)")
  })

  it("shows the empty state when the analytics rows are undefined", () => {
    render(<TopCategoriesChart data={undefined} loading={false} />)
    expect(captured.xAxis).toHaveLength(0)
    expect(
      screen.getByText("Keine Ausgaben im gewählten Zeitraum.")
    ).toBeTruthy()
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
    cleanup()
    // a malformed payload must not reach Recharts as domain [0, Infinity]
    render(
      <TopCategoriesChart
        data={[category({ totalCents: Number.POSITIVE_INFINITY, share: 0.5 })]}
        loading={false}
      />
    )
    expect(captured.xAxis).toHaveLength(0)
  })
})
