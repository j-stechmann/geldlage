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
  ComposedChart,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"
import type { AnalyticsResponse } from "@/components/analytics-kpis"
import { resolveCategoryColor } from "@/lib/category-colors"

const cashflowConfig = {
  income: { label: "Einnahmen", color: "var(--chart-2)" },
  expenses: { label: "Ausgaben", color: "var(--chart-1)" },
  net: { label: "Netto", color: "var(--chart-4)" },
} satisfies ChartConfig

const balanceConfig = {
  balance: { label: "Kontostand", color: "var(--chart-2)" },
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

export function CashflowChart({
  data,
  loading,
}: {
  data: AnalyticsResponse["monthlyCashflow"] | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () =>
      (data ?? []).map((d) => ({
        month: d.month,
        income: d.incomeCents / 100,
        expenses: -d.expensesCents / 100,
        net: d.netCents / 100,
      })),
    [data]
  )
  const zoom = useChartZoom({
    length: chartData.length,
    resetKey: chartData.length
      ? `${chartData[0].month}..${chartData[chartData.length - 1].month}:${chartData.length}`
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
                <Bar dataKey="income" fill="var(--color-income)" radius={4} />
                <Bar
                  dataKey="expenses"
                  fill="var(--color-expenses)"
                  radius={4}
                />
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

export function BalanceChart({
  data,
  loading,
}: {
  data: AnalyticsResponse["balanceTimeline"] | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () =>
      (data ?? []).map((d) => ({
        date: d.date,
        balance: d.balanceCents / 100,
      })),
    [data]
  )
  const zoom = useChartZoom({
    length: chartData.length,
    resetKey: chartData.length
      ? `${chartData[0].date}..${chartData[chartData.length - 1].date}:${chartData.length}`
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
          ab frühestem Kontostand-Snapshot (alle Konten)
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
                />
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
  loading,
}: {
  data: AnalyticsResponse["topCategories"] | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () =>
      (data ?? []).map((c) => ({
        name: c.name,
        value: c.totalCents / 100,
        share: c.share,
        fill: resolveCategoryColor(c.categoryId, c.color),
      })),
    [data]
  )
  const config = React.useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {}
    for (const d of chartData) {
      cfg[d.name] = { label: d.name, color: d.fill }
    }
    return cfg
  }, [chartData])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Ausgabenkategorien</CardTitle>
        <CardDescription>Anteil an den Gesamtausgaben</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-72 w-full" />
        ) : chartData.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Keine Ausgaben im gewählten Zeitraum.
          </p>
        ) : (
          <ChartContainer config={config} className="mx-auto h-72 w-full">
            <BarChart data={chartData} layout="vertical" accessibilityLayer>
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
                      const share = item?.payload as
                        { share?: number } | undefined
                      return `${Number(value).toLocaleString("de-DE", { minimumFractionDigits: 2 })} € (${share?.share != null ? Math.round(share.share * 100) : 0} %)`
                    }}
                  />
                }
              />
              <Bar dataKey="value" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
