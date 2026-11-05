"use client"

import * as React from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { useChartZoom } from "@/hooks/use-chart-zoom"
import { RotateCcw } from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  XAxis,
  YAxis,
  type XAxisTickContentProps,
} from "recharts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import type { ForecastResult } from "@/components/planning/api"
import { resolveCategoryColor } from "@/lib/category-colors"

const cashflowConfig = {
  income: { label: "Einnahmen", color: "var(--chart-2)" },
  expenses: { label: "Ausgaben", color: "var(--chart-1)" },
  net: { label: "Netto", color: "var(--chart-4)" },
  plannedIncome: { label: "Geplant (Einnahmen)", color: "var(--chart-2)" },
  plannedExpenses: { label: "Geplant (Ausgaben)", color: "var(--chart-1)" },
} satisfies ChartConfig

const balanceConfig = {
  balance: { label: "Kontostand", color: "var(--chart-2)" },
  projected: { label: "Prognose", color: "var(--chart-4)" },
} satisfies ChartConfig

function shortMonth(month: string): string {
  const [y, m] = month.split("-")
  const names = [
    "Jan",
    "Feb",
    "Mär",
    "Apr",
    "Mai",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Okt",
    "Nov",
    "Dez",
  ]
  return `${names[Number.parseInt(m, 10) - 1]} ${y.slice(2)}`
}

function euroShort(euros: number): string {
  return Math.round(euros).toLocaleString("de-DE")
}

/** One merged row of the planned-vs-actual categories chart. */
export interface CategoryTooltipRow {
  /** Ist euros of the actual-filter period (0 = planned-only row) */
  value?: number
  planned?: number
  /** share among the row's own denominator: the Ist total for actual rows, the planned horizon total for planned-only rows */
  share?: number
}

/**
 * Tooltip text of one stacked segment of the planned-vs-actual categories
 * chart (exported for the denominator regression tests). Each segment prints
 * its own amount exactly once: the planned (washed) entry prints the planned
 * amount, the Ist entry the Ist amount. The Ist entry carries a share against
 * the Ist-period total; a planned-only row's planned entry carries its share
 * against the forecast horizon. Both bases are named explicitly, so the two
 * scopes overlaid by the chart can never be mistaken for each other.
 */
export function topCategoriesTooltip(
  value: unknown,
  name: unknown,
  item: { payload?: CategoryTooltipRow } | undefined | null
): string {
  const payload = item?.payload
  const fmt = (n: number) =>
    n.toLocaleString("de-DE", { minimumFractionDigits: 2 })
  // The two scopes carry DIFFERENT share denominators: Ist rows divide by
  // the filtered period's total, planned-only rows by the forecast horizon's
  // total. Name the basis — a bare " (N %)" could silently belong to either.
  const isIstRow = (payload?.value ?? 0) > 0
  const share = payload?.share
  const shareText =
    share != null
      ? `(${Math.round(share * 100)} % ${isIstRow ? "der Ist-Ausgaben" : "der geplanten Ausgaben"})`
      : undefined
  if (name === "planned") {
    // mixed rows only store the Ist share; the horizon share exists on
    // planned-only rows, which is where this entry belongs
    return [`${fmt(Number(value))} € geplant`, isIstRow ? undefined : shareText]
      .filter((part): part is string => part != null)
      .join(" ")
  }
  return [`${fmt(Number(value))} €`, isIstRow ? shareText : undefined]
    .filter((part): part is string => part != null)
    .join(" ")
}

/**
 * Human-friendly X-axis ticks for the Top-Ausgabenkategorien chart. The
 * default Recharts algorithm divides the domain into arbitrary steps (650 €,
 * 1.300 €, …), which reads as random. Snap to the 1/2/2.5/5 × 10^n
 * candidates instead, ceiled to whole euros so the rounded tick labels stay
 * unique, and append the data maximum as the final tick: the domain is
 * pinned to that maximum (bars keep their full width), so without the last
 * tick the longest bar would run past every label.
 *
 * The axis is euro-only on purpose. Percent shares have two different
 * denominators while the forecast overlay is on (see topCategoriesMerge) and
 * their 100 % point is the total spend, not the largest bar — as a second
 * tick scale they would be misread and their labels collapse to 2-3 at the
 * card's width. Shares stay in the tooltip, where the basis is named.
 *
 * A sub-euro maximum degrades to the zero tick: the formatter prints whole
 * euros, so every finer label would round to the same value.
 */
export function topCategoryAxisTicks(maxEuros: number): number[] {
  if (!(maxEuros > 0) || !Number.isFinite(maxEuros)) return [0]
  if (maxEuros < 1) return [0]
  const rough = maxEuros / 5
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = Math.max(
    1,
    Math.ceil(
      (normalized <= 1
        ? 1
        : normalized <= 2
          ? 2
          : normalized <= 2.5
            ? 2.5
            : normalized <= 5
              ? 5
              : 10) * magnitude
    )
  )
  if (!Number.isFinite(step) || step <= 0) return [0]
  const ticks: number[] = []
  for (let value = 0; value < maxEuros; value += step) {
    ticks.push(value)
  }
  // Only append the raw maximum when its rounded label is not already the
  // previous tick's (1,2 € would otherwise share the "1 €" label with 1 €).
  const last = ticks[ticks.length - 1]
  if (Math.round(maxEuros) > Math.round(last)) ticks.push(maxEuros)
  return ticks
}

/**
 * Two-line X-axis tick of the Top-Ausgabenkategorien chart: the euro value and,
 * while the forecast overlay is off, its share of the filtered Ist total. The
 * share is a readout, not a 0-100 % scale — the axis ends on the largest bar
 * total, so the 100 % point (total spend) is off-chart. Stacking the lines
 * instead of `1.000 € · 13 %` keeps the label as narrow as the euro-only one;
 * at the card's one-third width a single-line dual label thinned out to 2-3
 * ticks. With the overlay on there are two share denominators, so only euros
 * render (see topCategoriesMerge).
 */
export function topCategoryAxisLabels(
  euros: number,
  totalEuros: number
): { euro: string; share: string | undefined } {
  return {
    euro: `${euroShort(euros)} €`,
    share:
      totalEuros > 0
        ? `${Math.round((euros / totalEuros) * 100)} %`
        : undefined,
  }
}

function TopCategoryAxisTick({
  x,
  y,
  payload,
  textAnchor,
  fill,
  totalEuros,
}: XAxisTickContentProps & { totalEuros: number }) {
  const { euro, share } = topCategoryAxisLabels(
    Number(payload.value),
    totalEuros
  )
  return (
    <text
      x={x}
      y={y}
      dy={12}
      textAnchor={textAnchor}
      fill={fill}
      fontSize={12}
      className="recharts-text recharts-cartesian-axis-tick-value"
    >
      <tspan x={x}>{euro}</tspan>
      {share ? (
        <tspan x={x} dy={14}>
          {share}
        </tspan>
      ) : null}
    </text>
  )
}

function ZoomResetButton({
  zoomed,
  onReset,
}: {
  zoomed: boolean
  onReset: () => void
}) {
  if (!zoomed) return null
  return (
    <Button variant="ghost" size="sm" onClick={onReset}>
      <RotateCcw data-icon="inline-start" />
      Zoom zurücksetzen
    </Button>
  )
}

/**
 * Merged monthly rows when the forecast toggle is on. Planned sums already
 * exclude matched occurrences (booked money lives in the actual bars), so
 * per month: actual + planned never double-count. The net line adds both —
 * for past months planned contributes 0, for the current month it covers
 * the remaining dated-from-today plans, for future months it is the whole
 * row.
 *
 * Zero segments become `undefined` instead of 0: recharts keeps tooltip
 * items with `value != null`, so a 0 planned segment would print a
 * "0,00 € geplant" row under every history month (and a "Einnahmen
 * 0,00 €" row under plan-only months). Exported for the zero-row
 * regression tests.
 *
 * PLANNED EXPENSES KEEP THE EXPENSE SIGN: the wire's `expensesCents` is
 * positive, but this chart renders the Ist expense bar negated (downward,
 * the app's original cashflow convention) — `plannedExpenses` mirrors that
 * so the forecast-mode stack (stackOffset "sign") stacks the remaining
 * planned outflow BELOW the actual outflow instead of into the income pile.
 */
export function mergeCashflow(
  history: AnalyticsResponse["monthlyCashflow"],
  forecast: ForecastResult | undefined
): Array<{
  month: string
  income: number | undefined
  expenses: number | undefined
  net: number
  plannedIncome: number | undefined
  plannedExpenses: number | undefined
}> {
  const rows = (history ?? []).map((d) => ({
    month: d.month,
    income: d.incomeCents / 100,
    expenses: -d.expensesCents / 100,
    net: d.netCents / 100,
    // only the forecast merge below fills these; undefined keeps months
    // without planned money out of the tooltip
    plannedIncome: undefined as number | undefined,
    plannedExpenses: undefined as number | undefined,
  }))
  if (!forecast) return rows
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  const extra: Array<{
    month: string
    income: number | undefined
    expenses: number | undefined
    net: number
    plannedIncome: number | undefined
    plannedExpenses: number | undefined
  }> = []
  for (const p of forecast.monthlyPlanned) {
    const row = byMonth.get(p.month)
    const plannedNet = (p.incomeCents - p.expensesCents) / 100
    if (row) {
      row.plannedIncome = p.incomeCents !== 0 ? p.incomeCents / 100 : undefined
      row.plannedExpenses =
        p.expensesCents !== 0 ? -(p.expensesCents / 100) : undefined
      row.net += plannedNet
    } else {
      extra.push({
        month: p.month,
        income: undefined,
        expenses: undefined,
        net: plannedNet,
        plannedIncome: p.incomeCents !== 0 ? p.incomeCents / 100 : undefined,
        plannedExpenses:
          p.expensesCents !== 0 ? -(p.expensesCents / 100) : undefined,
      })
    }
  }
  return [...rows, ...extra].sort((a, b) => a.month.localeCompare(b.month))
}

export function CashflowChart({
  data,
  forecast,
  loading,
}: {
  data: AnalyticsResponse["monthlyCashflow"] | undefined
  forecast?: ForecastResult | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () => mergeCashflow(data ?? [], forecast),
    [data, forecast]
  )
  const zoom = useChartZoom({
    length: chartData.length,
    resetKey: chartData.length
      ? `${chartData[0].month}..${chartData[chartData.length - 1].month}:${chartData.length}${forecast === undefined ? "" : "+f"}`
      : "0",
  })
  const { wrapRef, handlers } = zoom
  const visible = zoom.slice(chartData)

  // stacked ONLY while the overlay is on: the translucent planned segments
  // must land on top of the real bars in one column; with the toggle off the
  // bars keep the pre-planning grouped layout (income/expenses side by side,
  // heights individually comparable) instead of silently changing the
  // dashboard's default chart
  const flowStackId = forecast !== undefined ? "flow" : undefined

  // @min-[1024px] (container query on <main>, same threshold as the grid
  // in app/page.tsx): a col-span keyed off the viewport would still span 2
  // when the dock squeezes main below 1024px on a wide window — the card
  // would span an implicit second column instead of stacking full-width.
  return (
    <Card className="@min-[1024px]:col-span-2">
      <CardHeader>
        <CardTitle>Monatlicher Cashflow</CardTitle>
        <CardDescription>
          Einnahmen, Ausgaben und Saldo pro Monat
          {forecast ? " — ab heute geplant (halbdurchsichtig)" : ""}
        </CardDescription>
        <ZoomResetButton zoomed={zoom.isZoomed} onReset={zoom.reset} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <div ref={wrapRef} className="h-72 w-full touch-none" {...handlers}>
            <ChartContainer config={cashflowConfig} className="h-72 w-full">
              <ComposedChart
                data={visible}
                accessibilityLayer
                /* the flow stack mixes signs (Ist Ausgaben render downward)
                   — "sign" is what makes the stacked segments accumulate
                   upward/downward per sign instead of carving inward over
                   the income bar; all-positive bars behave identically */
                stackOffset="sign"
              >
                <CartesianGrid vertical={false} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  tickFormatter={(v: number) => euroShort(v)}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        `${Number(value).toLocaleString("de-DE", { minimumFractionDigits: 2 })} €`
                      }
                      labelFormatter={(label) => shortMonth(String(label))}
                    />
                  }
                />
                <Bar
                  dataKey="income"
                  stackId={flowStackId}
                  fill="var(--color-income)"
                  radius={4}
                />
                <Bar
                  dataKey="expenses"
                  stackId={flowStackId}
                  fill="var(--color-expenses)"
                  radius={4}
                />
                {forecast !== undefined && (
                  <>
                    <Bar
                      dataKey="plannedIncome"
                      stackId="flow"
                      fill="var(--color-income)"
                      fillOpacity={0.35}
                      radius={4}
                    />
                    <Bar
                      dataKey="plannedExpenses"
                      stackId="flow"
                      fill="var(--color-expenses)"
                      fillOpacity={0.35}
                      radius={4}
                    />
                  </>
                )}
                <Line
                  dataKey="net"
                  stroke="var(--color-net)"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ChartContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Merged series when the forecast toggle is on: the solid balance line runs
 * through the real history; at its last point the dashed projection takes
 * over (running balance from real future bookings + unmatched, still-future
 * planned occurrences of active plans — see computeForecast). A history
 * extending beyond today (imported future bookings) suppresses the
 * projection line entirely: its anchor overlaps real dates and the merged
 * line would run backwards.
 * With NO history at all (fresh user: no snapshots, no bookings) the dashed
 * projection stands alone from today so planned-only balances still render.
 * Exported for the balance-merge regression tests (connection-point
 * semantics).
 */
export function mergeBalance(
  hist: AnalyticsResponse["balanceTimeline"],
  forecast: ForecastResult | undefined
): Array<{ date: string; balance: number | null; projected: number | null }> {
  const points: Array<{
    date: string
    balance: number | null
    projected: number | null
  }> = hist.map((d) => ({
    date: d.date,
    balance: d.balanceCents / 100,
    projected: null,
  }))
  if (!forecast) return points
  const last = points[points.length - 1]
  if (last && last.date > forecast.today) return points
  if (last) {
    // connect the dashed series at the history's end. When the history ends
    // ON today, anchor at the projection's own today point: it already folds
    // the planned occurrences dated today into its baseline, while
    // last.balance is booked-only — starting the dashed line at last.balance
    // would push today's planned movement onto the next plotted date (and,
    // with no later movement at all, drop it from the line entirely).
    // last.date < today keeps this untouched: the projection's today point
    // arrives as its own plotted point there.
    const todayPoint =
      last.date === forecast.today
        ? forecast.projectedBalance.find((p) => p.date === forecast.today)
        : undefined
    last.projected = todayPoint ? todayPoint.balanceCents / 100 : last.balance
    for (const p of forecast.projectedBalance) {
      if (p.date <= last.date) continue
      points.push({
        date: p.date,
        balance: null,
        projected: p.balanceCents / 100,
      })
    }
    return points
  }
  // no real balance points: the projection is the only series
  for (const p of forecast.projectedBalance) {
    points.push({
      date: p.date,
      balance: null,
      projected: p.balanceCents / 100,
    })
  }
  return points
}

export function BalanceChart({
  data,
  forecast,
  loading,
}: {
  data: AnalyticsResponse["balanceTimeline"] | undefined
  forecast?: ForecastResult | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () => mergeBalance(data ?? [], forecast),
    [data, forecast]
  )
  const zoom = useChartZoom({
    length: chartData.length,
    resetKey: chartData.length
      ? `${chartData[0].date}..${chartData[chartData.length - 1].date}:${chartData.length}${forecast === undefined ? "" : "+f"}`
      : "0",
  })
  const { wrapRef, handlers } = zoom
  const visible = zoom.slice(chartData)

  // @min-[1024px] (container query on <main>, same threshold as the grid
  // in app/page.tsx): a col-span keyed off the viewport would still span
  // columns when the dock squeezes main below 1024px on a wide window —
  // the card would create an implicit column instead of stacking
  // full-width. The timeline is the dashboard's hero chart and spans the
  // grid's full width.
  return (
    <Card className="@min-[1024px]:col-span-3">
      <CardHeader>
        <CardTitle>Kontostand über Zeit</CardTitle>
        <CardDescription>
          {forecast
            ? `Ist ab frühestem Snapshot, Prognose ${forecast.horizon.from.slice(5).replace("-", "/")}–${forecast.horizon.to.slice(5).replace("-", "/")} (gestrichelt)`
            : "ab frühestem Kontostand-Snapshot (alle Konten)"}
        </CardDescription>
        <ZoomResetButton zoomed={zoom.isZoomed} onReset={zoom.reset} />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <div ref={wrapRef} className="h-72 w-full touch-none" {...handlers}>
            <ChartContainer config={balanceConfig} className="h-72 w-full">
              <LineChart data={visible} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  tickFormatter={(v: number) => euroShort(v)}
                />
                <ChartTooltip
                  cursor={{
                    stroke: "var(--muted-foreground)",
                    strokeDasharray: "4 4",
                  }}
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        `${Number(value).toLocaleString("de-DE", { minimumFractionDigits: 2 })} €`
                      }
                      labelFormatter={(label) => `Kontostand am ${label}`}
                    />
                  }
                />
                <Line
                  dataKey="balance"
                  stroke="var(--color-balance)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
                {forecast !== undefined && (
                  <Line
                    dataKey="projected"
                    stroke="var(--color-projected)"
                    strokeWidth={2}
                    strokeDasharray="6 4"
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                  />
                )}
              </LineChart>
            </ChartContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** One row of the Top-Ausgabenkategorien chart (Ist value + planned stack). */
export interface TopCategoryRow {
  categoryId: number | null
  name: string
  value: number
  /** undefined = no planned money: the merged/tooltip segment must vanish, never print as a 0-value bar */
  planned: number | undefined
  share: number
  fill: string
}

/**
 * Merged rows of the planned-vs-actual categories chart (exported for the
 * merge-identity regression tests). Rows are FRESH COPIES: mutating the
 * memoized Ist rows in place leaked the planned sums into `chartData` —
 * with the toggle off (merged === chartData) that stale planned value kept
 * appearing in tooltips until the next analytics refetch.
 * Merge by CATEGORY ID, not name: the engine labels actual uncategorized
 * spending "Unlabeled" while plannedCategories calls the same bucket
 * "ohne Kategorie" — keyed on the id (null == null) the planned money
 * stacks onto its true bucket instead of a twin row.
 *
 * Rows WITHOUT planned money carry `planned: undefined` (not 0): recharts
 * keeps tooltip items with `value != null`, so a 0-value planned segment
 * under a purely-Ist category would print a noise "0,00 € geplant" row.
 * Planned-only rows keep `value: 0` — their Ist segment prints a bare
 * "0,00 €"; the planned segment owns the planned amount and the horizon
 * share.
 */
export function topCategoriesMerge(
  chartData: TopCategoryRow[],
  forecast: ForecastResult | undefined
): TopCategoryRow[] {
  if (!forecast) return chartData
  const rows = chartData.map((r) => ({ ...r }))
  const byId = new Map(rows.map((r) => [r.categoryId, r]))
  for (const p of forecast.plannedCategories) {
    const planned = p.totalCents / 100
    const existing = byId.get(p.categoryId)
    if (existing) {
      existing.planned = planned
    } else {
      rows.push({
        categoryId: p.categoryId,
        name: p.name,
        value: 0,
        planned,
        share: p.share,
        fill: resolveCategoryColor(p.categoryId, p.color),
      })
    }
  }
  return rows
    .sort(
      (a, b) =>
        // planned is number here (0 = never planned); zeroing to undefined
        // happens only after the combined-total sort below
        b.value + (b.planned ?? 0) - (a.value + (a.planned ?? 0)) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 12)
    .map((r) => (r.planned === 0 ? { ...r, planned: undefined } : r))
}

export function TopCategoriesChart({
  data,
  forecast,
  loading,
}: {
  data: AnalyticsResponse["topCategories"] | undefined
  forecast?: ForecastResult | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () =>
      (data ?? []).map((c) => ({
        /** identity for the forecast merge: null = the uncategorized bucket */
        categoryId: c.categoryId,
        name: c.name,
        value: c.totalCents / 100,
        /** 0 = merge-owned field while the forecast is idle; the planned
         * series below stays gated OFF then (recharts keeps 0-value tooltip
         * entries — `value != null` — so an un-gated series would print a
         * noise "0,00 € geplant" line under every row) */
        planned: 0,
        share: c.share,
        fill: resolveCategoryColor(c.categoryId, c.color),
      })),
    [data]
  )
  const merged = React.useMemo(
    () => topCategoriesMerge(chartData, forecast),
    [chartData, forecast]
  )
  const xMax = React.useMemo(
    () =>
      merged.reduce((max, d) => Math.max(max, d.value + (d.planned ?? 0)), 0),
    [merged]
  )
  const xTicks = React.useMemo(() => topCategoryAxisTicks(xMax), [xMax])
  // Ist-period total behind the API's `share` values. The response is capped
  // at 12 rows, but share is computed against ALL expense categories, so any
  // row with money recovers the denominator (before the tick labels append
  // their percentage readout).
  const totalIst = React.useMemo(() => {
    const row = (data ?? []).find((c) => c.totalCents > 0 && c.share > 0)
    return row ? row.totalCents / 100 / row.share : 0
  }, [data])
  // The second tick line needs a single denominator. Hide it once planned
  // money actually shares the axis (planned-only rows use the horizon total);
  // an overlay with no planned expenses leaves the chart Ist-only.
  const hasPlannedMoney = merged.some((d) => (d.planned ?? 0) > 0)
  const withShareTicks = !hasPlannedMoney && totalIst > 0
  const config = React.useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {}
    for (const d of merged) {
      cfg[d.name] = { label: d.name, color: d.fill }
    }
    return cfg
  }, [merged])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Ausgabenkategorien</CardTitle>
        <CardDescription>
          {forecast
            ? "Ist + geplant (hell): Ist = gewählter Zeitraum, Geplant = Prognose-Horizont"
            : "Anteil an den Gesamtausgaben"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-72 w-full" />
        ) : merged.length === 0 || !(xMax > 0) ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Keine Ausgaben im gewählten Zeitraum.
          </p>
        ) : (
          <ChartContainer config={config} className="mx-auto h-72 w-full">
            <BarChart
              data={merged}
              layout="vertical"
              accessibilityLayer
              /* the last tick sits on the right edge; without a right margin
                 its middle-anchored label is clipped by the SVG */
              margin={{ top: 5, right: 40, bottom: 5, left: 5 }}
            >
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                domain={[0, xMax]}
                ticks={xTicks}
                niceTicks="none"
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={16}
                height={withShareTicks ? 44 : 30}
                /* Recharts measures minTickGap from tickFormatter; the
                   custom tick below renders the same euro line */
                tickFormatter={(v: number) => `${euroShort(v)} €`}
                tick={(props: XAxisTickContentProps) => (
                  <TopCategoryAxisTick
                    {...props}
                    totalEuros={withShareTicks ? totalIst : 0}
                  />
                )}
              />
              <YAxis
                dataKey="name"
                type="category"
                width={120}
                tickLine={false}
                axisLine={false}
                /* the visible XAxis costs 30-44px of plot height, so Recharts'
                   default preserveEnd starts dropping every other category
                   label; the chart caps at 12 rows in h-72, where all fit */
                interval={0}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name, item) =>
                      topCategoriesTooltip(value, name, item ?? undefined)
                    }
                  />
                }
              />
              <Bar dataKey="value" stackId="cat" radius={4} />
              {forecast !== undefined && (
                /* the planned series must NOT register when the forecast is
                   off: recharts keeps tooltip entries with `value != null`,
                   so the rows' 0-value planned field would print a noise
                   "0,00 € geplant" line under every Ist row (the data-side
                   0 → undefined normalization in topCategoriesMerge only
                   runs while the forecast is on). Same series-visibility
                   gate as the cashflow and balance overlays. */
                <Bar
                  dataKey="planned"
                  stackId="cat"
                  fillOpacity={0.35}
                  radius={4}
                >
                  {merged.map((d) => (
                    <Cell
                      // keyed on the merge identity, never the name: rows
                      // carry DISTINCT categoryIds (grouped by id on the Ist
                      // side, one catTotals entry per id on the planned side,
                      // null → the single uncategorized row), while two
                      // user-named categories can share a display name —
                      // a name key would render duplicate React keys
                      key={String(d.categoryId)}
                      fill={d.planned ? d.fill : "transparent"}
                    />
                  ))}
                </Bar>
              )}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
