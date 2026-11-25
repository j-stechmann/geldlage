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
import {
  PREDICTION_HORIZON_MONTHS,
  predictionMonthsLabel,
  type PredictionForecast,
} from "@/lib/contracts/prediction"
import { resolveCategoryColor } from "@/lib/category-colors"

const cashflowConfig = {
  income: { label: "Einnahmen", color: "var(--chart-2)" },
  expenses: { label: "Ausgaben", color: "var(--chart-1)" },
  net: { label: "Netto", color: "var(--chart-4)" },
  predictedIncome: { label: "Prognose (Einnahmen)", color: "var(--chart-2)" },
  predictedExpenses: { label: "Prognose (Ausgaben)", color: "var(--chart-1)" },
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

/** One merged row of the Ist-vs-Prognose categories chart. */
export interface CategoryTooltipRow {
  /** Ist euros of the actual-filter period (0 = prediction-only row) */
  value?: number
  predicted?: number
  /** share among the row's own denominator: the Ist total for actual rows, the prediction horizon total for prediction-only rows */
  share?: number
}

/**
 * Whole-percent text for a share fraction. Rounding must not claim something
 * false: a non-zero share below 0.5 % would print "0 %", and a share just
 * short of the total would print "100 %". Those become "<1 %" / ">99 %".
 * `zeroIsExact` decides what an exact zero means: the axis' 0 € tick is
 * genuinely 0 %, while a tooltip omits a zero share entirely.
 */
function sharePercentText(
  share: number,
  zeroIsExact: boolean
): string | undefined {
  if (!Number.isFinite(share) || share < 0) return undefined
  const rounded = Math.round(share * 100)
  if (rounded <= 0) {
    if (share === 0) return zeroIsExact ? "0 %" : undefined
    return "<1 %"
  }
  if (rounded >= 100 && share < 1) return ">99 %"
  return `${rounded} %`
}

/**
 * Tooltip text of one stacked segment of the Ist-vs-Prognose categories
 * chart. Each segment prints its own amount exactly once: the prediction
 * entry prints the predicted amount, the Ist entry the Ist amount.
 */
export function topCategoriesTooltip(
  value: unknown,
  name: unknown,
  item: { payload?: CategoryTooltipRow } | undefined | null
): string {
  const payload = item?.payload
  const fmt = (n: number) =>
    n.toLocaleString("de-DE", { minimumFractionDigits: 2 })
  const isIstRow = (payload?.value ?? 0) > 0
  const share = payload?.share
  const shareText = share != null ? sharePercentText(share, false) : undefined
  const withBasis = shareText
    ? `(${shareText} ${isIstRow ? "der Ist-Ausgaben" : "der prognostizierten Ausgaben"})`
    : undefined
  if (name === "predicted") {
    return [
      `${fmt(Number(value))} € Prognose`,
      isIstRow ? undefined : withBasis,
    ]
      .filter((part): part is string => part != null)
      .join(" ")
  }
  return [`${fmt(Number(value))} €`, isIstRow ? withBasis : undefined]
    .filter((part): part is string => part != null)
    .join(" ")
}

const TOP_CATEGORY_Y_AXIS_WIDTH = 120
const TOP_CATEGORY_MARGIN = { top: 5, right: 40, bottom: 5, left: 5 }
/** approximated width of a digit/punctuation at 12px, incl. the ` €` suffix */
const TOP_CATEGORY_LABEL_CHAR_WIDTH = 6
const TOP_CATEGORY_MIN_LABEL_WIDTH = 24
const TOP_CATEGORY_MIN_TICK_GAP = 8
const TOP_CATEGORY_MAX_TICKS = 6

function topCategoryAxisPlotWidth(chartWidth: number): number {
  return (
    chartWidth -
    TOP_CATEGORY_Y_AXIS_WIDTH -
    TOP_CATEGORY_MARGIN.left -
    TOP_CATEGORY_MARGIN.right
  )
}

/** Widest X tick label for a domain ending at `maxEuros`. */
function topCategoryAxisLabelWidth(maxEuros: number): number {
  const label = `${euroShort(maxEuros)} €`
  return Math.max(
    TOP_CATEGORY_MIN_LABEL_WIDTH,
    Math.ceil(label.length * TOP_CATEGORY_LABEL_CHAR_WIDTH)
  )
}

/**
 * How many X-axis ticks fit the measured chart width. Recharts decides on
 * its own which ticks to drop, and its `preserveStartEnd` subset is uneven
 * (0, 500, 1.500, 2.437, …). Pre-thinning to a count that fits lets the axis
 * pass `interval={0}` and render a stepped ladder instead. The label width
 * follows the formatted maximum, so six-digit euro amounts get fewer ticks
 * instead of overlapping labels.
 */
export function topCategoryAxisTickCount(
  chartWidth: number,
  maxEuros = 0
): number {
  if (!Number.isFinite(chartWidth) || chartWidth <= 0) return 2
  const plotWidth = topCategoryAxisPlotWidth(chartWidth)
  if (!(plotWidth > 0)) return 2
  const fit =
    Math.floor(
      plotWidth /
        (topCategoryAxisLabelWidth(maxEuros) + TOP_CATEGORY_MIN_TICK_GAP)
    ) + 1
  return Math.max(2, Math.min(TOP_CATEGORY_MAX_TICKS, fit))
}

/**
 * Smallest euro distance between two tick centres that keeps their labels
 * apart at this chart width. The appended data maximum is not part of the
 * regular 1/2/2.5/5 ladder, so without this guard it can land on top of the
 * previous tick (1.000 € / 1.001 €).
 */
export function topCategoryAxisMinGap(
  maxEuros: number,
  chartWidth: number
): number {
  if (!(maxEuros > 0) || !Number.isFinite(maxEuros)) return 0
  const plotWidth = topCategoryAxisPlotWidth(chartWidth)
  if (!(plotWidth > 0)) return 0
  return (
    ((topCategoryAxisLabelWidth(maxEuros) + TOP_CATEGORY_MIN_TICK_GAP) /
      plotWidth) *
    maxEuros
  )
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
 * `maxTicks` caps the ladder for the measured card width (see
 * topCategoryAxisTickCount), and `minGapEuros` keeps the appended maximum a
 * label-width away from the previous tick: a max just above a round tick
 * (1.000,50 €) drops that tick instead of printing "1.000 €" and
 * "1.001 €" on top of each other. A smaller cap yields a coarser
 * 1/2/2.5/5 step rather than a Recharts-picked, uneven subset. Callers that
 * render tick labels must pass the width-derived gap or the raw max can land
 * on the previous tick.
 *
 * The euro value is the primary scale. While the axis describes Ist money
 * alone (no predicted bars share it), a second tick line prints the share of
 * the filtered Ist total. That line is a readout, not a 0-100 % ruler: the
 * axis ends on the largest bar total, so its 100 % point (the total spend)
 * is usually off-chart. Once predicted money shares the axis there are two
 * share denominators (Ist period vs. prediction horizon, see
 * topCategoriesMerge), so only euros render and the basis lives in the
 * tooltip.
 *
 * A sub-euro maximum degrades to the zero tick: the formatter prints whole
 * euros, so every finer label would round to the same value.
 */
export function topCategoryAxisTicks(
  maxEuros: number,
  maxTicks = 6,
  minGapEuros = 0
): number[] {
  if (!(maxEuros > 0) || !Number.isFinite(maxEuros)) return [0]
  if (maxEuros < 1) return [0]
  // Not even the 0 € and max labels fit side by side: overlapping them would
  // be worse than showing the origin alone.
  if (minGapEuros > 0 && minGapEuros > maxEuros) return [0]
  // Never let a caller (Infinity/1e9) unbounded the loop.
  const requestedIntervals = Number.isFinite(maxTicks)
    ? Math.floor(maxTicks) - 1
    : TOP_CATEGORY_MAX_TICKS - 1
  const intervals = Math.max(
    1,
    Math.min(TOP_CATEGORY_MAX_TICKS - 1, requestedIntervals)
  )
  const rough = maxEuros / intervals
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
  if (Math.round(maxEuros) > Math.round(last)) {
    // Drop the regular tick the max would collide with; the previous one is
    // at least one step away, and the step is >= minGap by construction.
    if (minGapEuros > 0 && ticks.length > 1 && maxEuros - last < minGapEuros) {
      ticks.pop()
    }
    ticks.push(maxEuros)
  }
  return ticks
}

/**
 * Two-line X-axis tick of the Top-Ausgabenkategorien chart: the euro value and,
 * while the axis describes Ist money alone (`totalEuros > 0`), its share of the
 * filtered Ist total. The share is a readout, not a 0-100 % scale — the axis
 * ends on the largest bar total, so the 100 % point (total spend) is usually
 * off-chart. Stacking the lines instead of `1.000 € · 13 %` keeps the label as
 * narrow as the euro-only one; at the card's one-third width a single-line
 * dual label left room for only a few ticks. Once predicted money shares the
 * axis the component passes `totalEuros = 0`, so only euros render (see
 * topCategoriesMerge).
 *
 * Rounding must not claim something false: a non-zero tick below 0.5 % would
 * print "0 %", and a tick just short of the total would round to "100 %".
 * Those read as "<1 %" / ">99 %" instead, mirroring the tooltip.
 */
export function topCategoryAxisLabels(
  euros: number,
  totalEuros: number
): { euro: string; share: string | undefined } {
  const euro = `${euroShort(euros)} €`
  if (!(totalEuros > 0) || !Number.isFinite(totalEuros)) {
    return { euro, share: undefined }
  }
  return {
    euro,
    share: sharePercentText(euros / totalEuros, true),
  }
}

function TopCategoryAxisTick({
  x,
  y,
  payload,
  textAnchor,
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
      aria-label={share ? `${euro}, ${share} der Ist-Ausgaben` : euro}
      /* Recharts 3.x renders axis labels in .recharts-cartesian-axis-tick-label,
         which the shared ChartContainer selector does not match; theme this
         custom tick explicitly so it keeps WCAG contrast in dark mode instead
         of Recharts' #666 default */
      fill="var(--muted-foreground)"
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
 * Merged monthly rows for the always-on daily prediction. The prediction's
 * monthly buckets are the remaining amount for the current month and the
 * full amount for the next month, so they stack on top of the actual partial
 * bars without double counting. Zero segments become `undefined` so Recharts
 * does not print a noise "0,00 €" tooltip row.
 *
 * Predicted expenses keep the chart's expense sign (negative/downward), the
 * same convention as the actual expense bars.
 */
export function mergeCashflow(
  history: AnalyticsResponse["monthlyCashflow"],
  prediction: PredictionForecast | undefined
): Array<{
  month: string
  income: number | undefined
  expenses: number | undefined
  net: number
  predictedIncome: number | undefined
  predictedExpenses: number | undefined
}> {
  const rows: Array<{
    month: string
    income: number | undefined
    expenses: number | undefined
    net: number
    predictedIncome: number | undefined
    predictedExpenses: number | undefined
  }> = (history ?? []).map((d) => ({
    month: d.month,
    income: d.incomeCents / 100,
    expenses: -d.expensesCents / 100,
    net: d.netCents / 100,
    predictedIncome: undefined,
    predictedExpenses: undefined,
  }))
  if (!prediction) return rows
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  const extra: typeof rows = []
  for (const p of prediction.monthly) {
    const row = byMonth.get(p.month)
    const predictedNet = (p.incomeCents - p.expensesCents) / 100
    if (row) {
      row.predictedIncome =
        p.incomeCents !== 0 ? p.incomeCents / 100 : undefined
      row.predictedExpenses =
        p.expensesCents !== 0 ? -(p.expensesCents / 100) : undefined
      row.net += predictedNet
    } else {
      const income = p.incomeCents + p.bookedFuture.incomeCents
      const expenses = p.expensesCents + p.bookedFuture.expensesCents
      extra.push({
        month: p.month,
        income: undefined,
        expenses: undefined,
        net: (income - expenses) / 100,
        predictedIncome: income !== 0 ? income / 100 : undefined,
        predictedExpenses: expenses !== 0 ? -(expenses / 100) : undefined,
      })
    }
  }
  return [...rows, ...extra].sort((a, b) => a.month.localeCompare(b.month))
}

export function CashflowChart({
  data,
  prediction,
  loading,
}: {
  data: AnalyticsResponse["monthlyCashflow"] | undefined
  prediction?: PredictionForecast | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () => mergeCashflow(data ?? [], prediction),
    [data, prediction]
  )
  const zoom = useChartZoom({
    length: chartData.length,
    resetKey: chartData.length
      ? `${chartData[0].month}..${chartData[chartData.length - 1].month}:${chartData.length}${prediction === undefined ? "" : "+p"}`
      : "0",
  })
  const { wrapRef, handlers } = zoom
  const visible = zoom.slice(chartData)

  return (
    <Card className="@min-[1024px]:col-span-2">
      <CardHeader>
        <CardTitle>Monatlicher Cashflow</CardTitle>
        <CardDescription>
          {prediction
            ? `Einnahmen, Ausgaben und Saldo pro Monat — Prognose für ${prediction.horizon.months} ${predictionMonthsLabel(prediction.horizon.months)} (halbdurchsichtig)`
            : "Einnahmen, Ausgaben und Saldo pro Monat"}
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
                {prediction !== undefined && (
                  <>
                    <Bar
                      dataKey="predictedIncome"
                      stackId="flow"
                      fill="var(--color-income)"
                      fillOpacity={0.35}
                      radius={4}
                    />
                    <Bar
                      dataKey="predictedExpenses"
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
 * Merged balance series. The solid line is booked history clipped at today;
 * the dashed line takes over at its last point using the daily prediction's
 * projected balance. Post-dated booked history is clipped so the projection
 * stays visible and the merged line cannot run backwards. With no history at
 * all, the projection stands alone.
 */
export function mergeBalance(
  hist: AnalyticsResponse["balanceTimeline"],
  prediction: PredictionForecast | undefined
): Array<{ date: string; balance: number | null; projected: number | null }> {
  const points: Array<{
    date: string
    balance: number | null
    projected: number | null
  }> = (prediction ? hist.filter((d) => d.date <= prediction.today) : hist).map(
    (d) => ({
      date: d.date,
      balance: d.balanceCents / 100,
      projected: null,
    })
  )
  if (!prediction) return points
  const last = points[points.length - 1]
  if (last) {
    const todayPoint =
      last.date === prediction.today
        ? prediction.projectedBalance.find((p) => p.date === prediction.today)
        : undefined
    last.projected = todayPoint ? todayPoint.balanceCents / 100 : last.balance
    for (const p of prediction.projectedBalance) {
      if (p.date <= last.date) continue
      points.push({
        date: p.date,
        balance: null,
        projected: p.balanceCents / 100,
      })
    }
  } else {
    for (const p of prediction.projectedBalance) {
      points.push({
        date: p.date,
        balance: null,
        projected: p.balanceCents / 100,
      })
    }
  }
  // Booked history beyond the prediction horizon remains actual data and
  // must not disappear just because the projection ends earlier.
  for (const d of hist) {
    if (d.date > prediction.horizon.to) {
      points.push({
        date: d.date,
        balance: d.balanceCents / 100,
        projected: null,
      })
    }
  }
  return points
}

export function BalanceChart({
  data,
  prediction,
  loading,
}: {
  data: AnalyticsResponse["balanceTimeline"] | undefined
  prediction?: PredictionForecast | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () => mergeBalance(data ?? [], prediction),
    [data, prediction]
  )
  const zoom = useChartZoom({
    length: chartData.length,
    resetKey: chartData.length
      ? `${chartData[0].date}..${chartData[chartData.length - 1].date}:${chartData.length}${prediction === undefined ? "" : "+p"}`
      : "0",
  })
  const { wrapRef, handlers } = zoom
  const visible = zoom.slice(chartData)

  return (
    <Card className="@min-[1024px]:col-span-3">
      <CardHeader>
        <CardTitle>Kontostand über Zeit</CardTitle>
        <CardDescription>
          {prediction
            ? `Ist ab frühestem Snapshot, Prognose ${prediction.horizon.from.slice(5).replace("-", "/")}–${prediction.horizon.to.slice(5).replace("-", "/")} (gestrichelt)`
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
                {prediction !== undefined && (
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

/** One row of the Top-Ausgabenkategorien chart (Ist value + predicted stack). */
export interface TopCategoryRow {
  categoryId: number | null
  name: string
  value: number
  /** undefined = no predicted money: the merged/tooltip segment must vanish */
  predicted: number | undefined
  share: number
  fill: string
}

/**
 * Merged rows of the Ist-vs-Prognose categories chart. Rows are fresh copies
 * so the memoized Ist rows are never mutated. Merge by CATEGORY ID, not name:
 * the analytics engine labels actual uncategorized spending "Unlabeled" while
 * the prediction calls the same bucket "ohne Kategorie".
 *
 * Rows without predicted money carry `predicted: undefined` (not 0) so
 * Recharts does not print a noise "0,00 €" tooltip segment.
 */
export function topCategoriesMerge(
  chartData: TopCategoryRow[],
  prediction: PredictionForecast | undefined
): TopCategoryRow[] {
  if (!prediction) return chartData
  const rows = chartData.map((r) => ({ ...r }))
  const byId = new Map(rows.map((r) => [r.categoryId, r]))
  const totals = new Map<
    number | null,
    { cents: number; name: string; color: string | null }
  >()
  for (const month of prediction.monthly) {
    for (const category of month.categories) {
      const prior = totals.get(category.categoryId) ?? {
        cents: 0,
        name: category.name,
        color: category.color,
      }
      prior.cents += category.expensesCents
      totals.set(category.categoryId, prior)
    }
  }
  const grand = [...totals.values()].reduce(
    (sum, value) => sum + value.cents,
    0
  )
  for (const [categoryId, value] of totals) {
    const predicted = value.cents / 100
    const existing = byId.get(categoryId)
    if (existing) {
      existing.predicted = predicted
    } else {
      rows.push({
        categoryId,
        name: value.name,
        value: 0,
        predicted,
        share: grand > 0 ? value.cents / grand : 0,
        fill: resolveCategoryColor(categoryId, value.color),
      })
    }
  }
  return rows
    .sort(
      (a, b) =>
        b.value + (b.predicted ?? 0) - (a.value + (a.predicted ?? 0)) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 12)
    .map((r) => (r.predicted === 0 ? { ...r, predicted: undefined } : r))
}

export function TopCategoriesChart({
  data,
  prediction,
  loading,
}: {
  data: AnalyticsResponse["topCategories"] | undefined
  prediction?: PredictionForecast | undefined
  loading: boolean
}) {
  const chartData = React.useMemo(
    () =>
      (data ?? []).map((c) => ({
        categoryId: c.categoryId,
        name: c.name,
        value: c.totalCents / 100,
        predicted: 0,
        share: c.share,
        fill: resolveCategoryColor(c.categoryId, c.color),
      })),
    [data]
  )
  const merged = React.useMemo(
    () => topCategoriesMerge(chartData, prediction),
    [chartData, prediction]
  )
  const xMax = React.useMemo(
    () =>
      merged.reduce((max, d) => Math.max(max, d.value + (d.predicted ?? 0)), 0),
    [merged]
  )
  // Recharts' own tick thinning drops a different subset per card width
  // (0, 500, 1.500, 2.437 at one size; 0, 1.000, 2.437 at another). Measure
  // the container, pick a count that fits, and let the axis render exactly
  // that stepped ladder (interval={0}) so the gaps stay predictable.
  const [chartWidth, setChartWidth] = React.useState(320)
  const onChartResize = React.useCallback(
    (width: number) => setChartWidth(width),
    []
  )
  const maxTicks = React.useMemo(
    () => topCategoryAxisTickCount(chartWidth, xMax),
    [chartWidth, xMax]
  )
  const xTicks = React.useMemo(
    () =>
      topCategoryAxisTicks(
        xMax,
        maxTicks,
        topCategoryAxisMinGap(xMax, chartWidth)
      ),
    [xMax, maxTicks, chartWidth]
  )
  // Ist-period total behind the API's `share` values. The response is capped
  // at 12 rows, but share is computed against ALL expense categories, so any
  // row with money recovers the denominator (before the tick labels append
  // their percentage readout).
  const totalIst = React.useMemo(() => {
    const row = (data ?? []).find((c) => c.totalCents > 0 && c.share > 0)
    return row ? row.totalCents / 100 / row.share : 0
  }, [data])
  // The second tick line needs a single denominator. Hide it once predicted
  // money actually shares the axis; a prediction with no expenses leaves the
  // chart Ist-only.
  const hasPredictedMoney = merged.some((d) => (d.predicted ?? 0) > 0)
  const showShareTicks = !hasPredictedMoney && totalIst > 0
  // Keep the axis height tied to the Ist denominator, not to the prediction:
  // the prediction prop starts undefined while loading, and a 44→30 px axis
  // would reflow every bar by 14 px. The extra line simply stays blank while
  // predicted money is on the axis.
  const axisHeight = totalIst > 0 ? 44 : 30
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
          {prediction
            ? `Ist + Prognose (hell): Ist = gewählter Zeitraum, Prognose = ${prediction?.horizon.months ?? PREDICTION_HORIZON_MONTHS} ${predictionMonthsLabel(prediction?.horizon.months ?? PREDICTION_HORIZON_MONTHS)}`
            : "Anteil an den Gesamtausgaben"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-72 w-full" />
        ) : merged.length === 0 || !(xMax > 0) || !Number.isFinite(xMax) ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Keine Ausgaben im gewählten Zeitraum.
          </p>
        ) : (
          <ChartContainer
            config={config}
            className="mx-auto h-72 w-full"
            onResize={onChartResize}
          >
            <BarChart
              data={merged}
              layout="vertical"
              accessibilityLayer
              /* the last tick sits on the right edge; without a right margin
                 its middle-anchored label is clipped by the SVG */
              margin={TOP_CATEGORY_MARGIN}
            >
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                domain={[0, xMax]}
                ticks={xTicks}
                niceTicks="none"
                tickLine={false}
                axisLine={false}
                /* xTicks is already thinned for the measured width: render
                   all of them, because Recharts' string intervals would drop
                   an uneven subset of the remaining ladder */
                interval={0}
                height={axisHeight}
                tickFormatter={(v: number) => `${euroShort(v)} €`}
                tick={(props: XAxisTickContentProps) => (
                  <TopCategoryAxisTick
                    {...props}
                    totalEuros={showShareTicks ? totalIst : 0}
                  />
                )}
              />
              <YAxis
                dataKey="name"
                type="category"
                width={TOP_CATEGORY_Y_AXIS_WIDTH}
                tickLine={false}
                axisLine={false}
                /* the shared ChartContainer selector does not match Recharts
                   3.x tick labels; theme this chart's category labels too so
                   the X and Y text share one contrast-safe colour */
                tick={{ fill: "var(--muted-foreground)" }}
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
              {prediction !== undefined && (
                <Bar
                  dataKey="predicted"
                  stackId="cat"
                  fillOpacity={0.35}
                  radius={4}
                >
                  {merged.map((d) => (
                    <Cell
                      key={String(d.categoryId)}
                      fill={d.predicted ? d.fill : "transparent"}
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
