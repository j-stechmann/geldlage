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
 * for past months planned is 0, for the current month it covers the
 * remaining dated-from-today plans, for future months it is the whole row.
 */
function mergeCashflow(
  history: AnalyticsResponse["monthlyCashflow"],
  forecast: ForecastResult | undefined
): Array<{
  month: string
  income: number
  expenses: number
  net: number
  plannedIncome: number
  plannedExpenses: number
}> {
  const rows = (history ?? []).map((d) => ({
    month: d.month,
    income: d.incomeCents / 100,
    expenses: -d.expensesCents / 100,
    net: d.netCents / 100,
    plannedIncome: 0,
    plannedExpenses: 0,
  }))
  if (!forecast) return rows
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  const extra: Array<{
    month: string
    income: number
    expenses: number
    net: number
    plannedIncome: number
    plannedExpenses: number
  }> = []
  for (const p of forecast.monthlyPlanned) {
    const row = byMonth.get(p.month)
    const plannedNet = (p.incomeCents - p.expensesCents) / 100
    if (row) {
      row.plannedIncome = p.incomeCents / 100
      row.plannedExpenses = p.expensesCents / 100
      row.net += plannedNet
    } else {
      extra.push({
        month: p.month,
        income: 0,
        expenses: 0,
        net: plannedNet,
        plannedIncome: p.incomeCents / 100,
        plannedExpenses: p.expensesCents / 100,
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
              <ComposedChart data={visible} accessibilityLayer>
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
                  stackId="flow"
                  fill="var(--color-income)"
                  radius={4}
                />
                <Bar
                  dataKey="expenses"
                  stackId="flow"
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
  const merged = React.useMemo(() => {
    if (!forecast) return chartData
    const rows = [...chartData]
    // merge by CATEGORY ID, not name: the engine labels actual
    // uncategorized spending "Unlabeled" while plannedCategories calls the
    // same bucket "ohne Kategorie" — keyed on the id (null == null) the
    // planned money stacks onto its true bucket instead of a twin row
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
          b.value + b.planned - (a.value + a.planned) ||
          a.name.localeCompare(b.name)
      )
      .slice(0, 12)
  }, [chartData, forecast])
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
                    formatter={(value, _name, item) => {
                      const payload = item?.payload as
                        { share?: number; planned?: number } | undefined
                      const share = payload?.share
                      const planned = payload?.planned ?? 0
                      return (
                        `${Number(value).toLocaleString("de-DE", { minimumFractionDigits: 2 })} €` +
                        (planned > 0
                          ? ` + ${planned.toLocaleString("de-DE", { minimumFractionDigits: 2 })} € geplant`
                          : "") +
                        (share != null ? ` (${Math.round(share * 100)} %)` : "")
                      )
                    }}
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
                    fill={d.planned > 0 ? d.fill : "transparent"}
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
