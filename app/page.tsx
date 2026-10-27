"use client"

import * as React from "react"
import { FilterBar } from "@/components/filter-bar"
import { KpiRow, useAnalytics } from "@/components/analytics-kpis"
import {
  BalanceChart,
  CashflowChart,
  TopCategoriesChart,
} from "@/components/analytics-charts"
import { ErrorState } from "@/components/error-state"
import { Button } from "@/components/ui/button"
import {
  EMPTY_FILTERS,
  filtersToParams,
  hasContentFilters,
  type TableFilters,
} from "@/lib/filters"
import { germanDate, useForecast } from "@/components/planning/api"
import { euro } from "@/lib/money"

const FORECAST_MONTHS = 12

export default function DashboardPage() {
  const [filters, setFilters] = React.useState<TableFilters>(EMPTY_FILTERS)
  const [forecastOn, setForecastOn] = React.useState(false)

  const params = React.useMemo(
    () => filtersToParams(filters).toString(),
    [filters]
  )

  const {
    data: analytics,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useAnalytics(params)

  // the planned-vs-actual overlay (ADR-0035): honors the account filter the
  // same way the balance does — content filters are out of scope for money
  // anchored on absolute snapshots. useForecast serves no cross-key
  // placeholder, so the figures/overlay stay blank while a differently
  // scoped projection loads instead of showing the previous account's
  // numbers.
  const forecastQuery = useForecast(
    forecastOn,
    FORECAST_MONTHS,
    filters.accountId
  )
  const forecast = forecastQuery.data

  const showLoading = isLoading || (isError && !analytics)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Analysen basieren auf den gefilterten Transaktionen.
        </p>
      </div>

      <FilterBar filters={filters} onChange={setFilters} />

      {isError && <ErrorState onRetry={() => void refetch()} />}

      <div
        className={`space-y-6 transition-opacity ${isFetching && !isLoading ? "opacity-70" : ""}`}
      >
        <KpiRow analytics={analytics} loading={showLoading} />

        <div
          className={`flex flex-wrap items-center gap-3 transition-opacity ${forecastOn && forecastQuery.isFetching ? "opacity-70" : ""}`}
        >
          <Button
            size="sm"
            variant={forecastOn ? "default" : "outline"}
            aria-pressed={forecastOn}
            onClick={() => setForecastOn((v) => !v)}
          >
            Geplant einblenden
          </Button>
          {forecastOn && forecast && (
            <span className="text-sm text-muted-foreground">
              Projektion{" "}
              <strong className="font-medium text-foreground tabular-nums">
                {euro(
                  forecast.projectedBalance[
                    forecast.projectedBalance.length - 1
                  ]?.balanceCents ?? null
                )}
              </strong>{" "}
              zum {germanDate(forecast.horizon.to)}
              {forecast.withoutSnapshot
                ? " (ohne Kontostand-Referenz: Summe der Buchungen)"
                : ""}
            </span>
          )}
          {forecastOn && !forecast && forecastQuery.isError && (
            /* a failed projection must not read as "no plans" (or worse, as
               an inert toggle): /planung's ErrorState + retry pattern */
            <ErrorState onRetry={() => void forecastQuery.refetch()} />
          )}
          {forecastOn && hasContentFilters(filters) && (
            <span className="text-xs text-muted-foreground">
              Geplante Beträge reagieren nur auf den Kontofilter, nicht auf die
              anderen Filter.
            </span>
          )}
        </div>

        {/* @min-[1024px] (container query on <main>) instead of viewport
            lg: the charts reflow against the space left of the agent dock.
            Container queries measure main's content box (px-4), so this
            fires ~2rem later than the viewport 1024px threshold. */}
        <div className="grid gap-4 @min-[1024px]:grid-cols-3">
          <BalanceChart
            data={analytics?.balanceTimeline}
            forecast={forecastOn ? forecast : undefined}
            loading={showLoading}
          />
          <CashflowChart
            data={analytics?.monthlyCashflow}
            forecast={forecastOn ? forecast : undefined}
            loading={showLoading}
          />
          <TopCategoriesChart
            data={analytics?.topCategories}
            forecast={forecastOn ? forecast : undefined}
            loading={showLoading}
          />
        </div>
      </div>
    </div>
  )
}
