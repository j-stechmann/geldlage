"use client"

import * as React from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { FilterBar } from "@/components/filter-bar"
import { TransactionsTable } from "@/components/transactions-table"
import { Skeleton } from "@/components/ui/skeleton"
import {
  paramsToFilters,
  filtersToParams,
  type TableFilters,
} from "@/lib/filters"

function TransactionsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const filters = React.useMemo(
    () => paramsToFilters(new URLSearchParams(searchParams.toString())),
    [searchParams]
  )

  const setFilters = React.useCallback(
    (next: TableFilters) => {
      const qs = filtersToParams(next).toString()
      router.replace(qs ? `/transactions?${qs}` : "/transactions", {
        scroll: false,
      })
    },
    [router]
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Transaktionen
        </h1>
        <p className="text-sm text-muted-foreground">
          Alle Transaktionen mit Filtern — die Filter stehen in der URL und
          lassen sich teilen.
        </p>
      </div>

      <FilterBar filters={filters} onChange={setFilters} />

      <TransactionsTable filters={filters} />
    </div>
  )
}

export default function TransactionsPage() {
  return (
    <React.Suspense
      fallback={
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <TransactionsPageInner />
    </React.Suspense>
  )
}
