"use client"

import * as React from "react"
import { FilterBar } from "@/components/filter-bar"
import { KpiRow, useAnalytics } from "@/components/analytics-kpis"
import {
  BalanceChart,
  CashflowChart,
  SavingsChart,
  TopCategoriesChart,
} from "@/components/analytics-charts"
import { ErrorState } from "@/components/error-state"
import {
  EMPTY_FILTERS,
  filtersToParams,
  type TableFilters,
} from "@/lib/filters"

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

        {/* @min-[1024px] (container query on <main>) instead of viewport
            lg: the charts reflow against the space left of the agent dock.
            Container queries measure main's content box (px-4), so this
            fires ~2rem later than the viewport 1024px threshold. */}
        <div className="grid gap-4 @min-[1024px]:grid-cols-3">
          <CashflowChart
            data={analytics?.monthlyCashflow}
            loading={showLoading}
          />
          <TopCategoriesChart
            data={analytics?.topCategories}
            loading={showLoading}
          />
          <BalanceChart
            data={analytics?.balanceTimeline}
            loading={showLoading}
          />
          <SavingsChart
            data={analytics?.savingsHistory}
            loading={showLoading}
          />
        </div>
      </div>
    </div>
  )
}
