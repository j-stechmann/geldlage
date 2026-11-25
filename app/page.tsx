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
import {
  EMPTY_FILTERS,
  filtersToParams,
  type TableFilters,
} from "@/lib/filters"
import { usePrediction } from "@/components/prediction/api"
import {
  PREDICTION_HORIZON_MONTHS,
  predictionMonthsLabel,
} from "@/lib/contracts/prediction"

export default function DashboardPage() {
  const [filters, setFilters] = React.useState<TableFilters>(EMPTY_FILTERS)

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

  // The daily prediction is always on and always shows two months. It honors
  // the account filter exactly; content filters stay out of scope because the
  // projection anchors on absolute booked money. No placeholder keeps a
  // previous account's figures from flashing under another account.
  const prediction = usePrediction(filters.accountId).data

  const showLoading = isLoading || (isError && !analytics)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Analysen basieren auf den gefilterten Transaktionen. Die Prognose
          zeigt immer die nächsten {PREDICTION_HORIZON_MONTHS}{" "}
          {predictionMonthsLabel(PREDICTION_HORIZON_MONTHS)} und reagiert nur
          auf den Kontofilter.
        </p>
      </div>

      <FilterBar filters={filters} onChange={setFilters} />

      {isError && <ErrorState onRetry={() => void refetch()} />}

      <div
        className={`space-y-6 transition-opacity ${isFetching && !isLoading ? "opacity-70" : ""}`}
      >
        <KpiRow analytics={analytics} loading={showLoading} />

        {/* @min-[1024px] (container query on <main>) instead of viewport
            lg: the charts reflow against the space left of the agent dock.
            Container queries measure main's content box (px-4), so this
            fires ~2rem later than the viewport 1024px threshold. */}
        <div className="grid gap-4 @min-[1024px]:grid-cols-3">
          <BalanceChart
            data={analytics?.balanceTimeline}
            prediction={prediction}
            loading={showLoading}
          />
          <CashflowChart
            data={analytics?.monthlyCashflow}
            prediction={prediction}
            loading={showLoading}
          />
          <TopCategoriesChart
            data={analytics?.topCategories}
            prediction={prediction}
            loading={showLoading}
          />
        </div>
      </div>
    </div>
  )
}
