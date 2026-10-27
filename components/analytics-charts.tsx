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
 * chart (exported for the denominator regression tests). The planned
 * (washed) segment entry prints its supplement alone; the Ist entry carries
 * a share ONLY where the row actually has Ist money — a planned-only row
 * would otherwise silently inherit the Ist-period " (N %)" denominator it
 * never contributed to (and the planned segment would double-print the
 * planned amount).
 */
export function topCategoriesTooltip(
  value: unknown,
  name: unknown,
  item: { payload?: CategoryTooltipRow } | undefined | null
): string {
  const payload = item?.payload
  const planned = payload?.planned ?? 0
  const fmt = (n: number) =>
    n.toLocaleString("de-DE", { minimumFractionDigits: 2 })
  if (name === "planned") {
    return `${fmt(Number(value))} € geplant`
  }
  const actualShare = (payload?.value ?? 0) > 0 ? payload?.share : undefined
  return (
    `${fmt(Number(value))} €` +
    (planned > 0 ? ` + ${fmt(planned)} € geplant` : "") +
    (actualShare != null ? ` (${Math.round(actualShare * 100)} %)` : "")
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
 * planned occurrences — see computeForecast). A history extending beyond
 * today (imported future bookings) suppresses the projection line entirely:
 * its anchor overlaps real dates and the merged line would run backwards.
 * With NO history at all (fresh user: no snapshots, no bookings) the dashed
 * projection stands alone from today so planned-only balances still render.
 */
function mergeBalance(
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
    last.projected = last.balance
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
 * printing " + X € geplant" in tooltips until the next analytics refetch.
 * Merge by CATEGORY ID, not name: the engine labels actual uncategorized
 * spending "Unlabeled" while plannedCategories calls the same bucket
 * "ohne Kategorie" — keyed on the id (null == null) the planned money
 * stacks onto its true bucket instead of a twin row.
 *
 * Rows WITHOUT planned money carry `planned: undefined` (not 0): recharts
 * keeps tooltip items with `value != null`, so a 0-value planned segment
 * under a purely-Ist category would print a noise "0,00 € geplant" row.
 * Planned-only rows keep `value: 0` — their Ist segment intentionally
 * prints "0,00 € + X € geplant".
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
        ) : merged.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Keine Ausgaben im gewählten Zeitraum.
          </p>
        ) : (
          <ChartContainer config={config} className="mx-auto h-72 w-full">
            <BarChart data={merged} layout="vertical" accessibilityLayer>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" hide />
              <YAxis
                dataKey="name"
                type="category"
                width={120}
                tickLine={false}
                axisLine={false}
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
              <Bar
                dataKey="planned"
                stackId="cat"
                fillOpacity={0.35}
                radius={4}
              >
                {merged.map((d) => (
                  <Cell
                    key={d.name}
                    fill={d.planned ? d.fill : "transparent"}
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
