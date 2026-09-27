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

  const urlFilters = React.useMemo(
    () => paramsToFilters(new URLSearchParams(searchParams.toString())),
    [searchParams]
  )
  const urlKey = filtersToParams(urlFilters).toString()

  // synchronous mirror of the URL filters: rapid changes compose instead of
  // racing against async router.replace commits
  const [filters, setFiltersState] = React.useState(urlFilters)
  const lastUrlKey = React.useRef(urlKey)
  const echoKeys = React.useRef<Set<string>>(new Set())

  React.useEffect(() => {
    if (lastUrlKey.current === urlKey) return
    lastUrlKey.current = urlKey
    // adopt only external URL changes (back/forward, shared links); echoes
    // of our own router.replace calls must not clobber newer local state
    if (echoKeys.current.has(urlKey)) {
      echoKeys.current.delete(urlKey)
    } else {
      setFiltersState(urlFilters)
    }
  }, [urlKey, urlFilters])

  const setFilters = React.useCallback(
    (next: TableFilters) => {
      const qs = filtersToParams(next).toString()
      if (qs !== lastUrlKey.current) {
        echoKeys.current.add(qs)
        if (echoKeys.current.size > 8) {
          const oldest = echoKeys.current.values().next().value
          if (oldest !== undefined) echoKeys.current.delete(oldest)
        }
      }
      setFiltersState(next)
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
