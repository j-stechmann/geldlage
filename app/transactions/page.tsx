"use client"

import * as React from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { FilterBar } from "@/components/filter-bar"
import { TransactionsTable } from "@/components/transactions-table"
import { Skeleton } from "@/components/ui/skeleton"
import { UrlEchoRegistry } from "@/lib/url-echo"
import {
  paramsToFilters,
  filtersToParams,
  type TableFilters,
} from "@/lib/filters"

// echoes older than this are dead: an interrupted/coalesced navigation never
// commits, and a lingering key would swallow a later genuine navigation to
// the same URL
const ECHO_TTL_MS = 10_000

function TransactionsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const urlFilters = React.useMemo(
    () => paramsToFilters(new URLSearchParams(searchParams.toString())),
    [searchParams]
  )
  const urlKey = filtersToParams(urlFilters).toString()

  // synchronous mirror of the URL filters: rapid changes compose instead of
  // racing against async router.push commits
  const [filters, setFiltersState] = React.useState(urlFilters)
  const lastUrlKey = React.useRef(urlKey)
  const echoRegistry = React.useRef<UrlEchoRegistry | null>(null)
  if (echoRegistry.current === null) {
    echoRegistry.current = new UrlEchoRegistry(ECHO_TTL_MS)
  }

  React.useEffect(() => {
    if (lastUrlKey.current === urlKey) return
    lastUrlKey.current = urlKey
    // adopt only external URL changes (back/forward, shared links); echoes
    // of our own router.push calls must not clobber newer local state
    if (echoRegistry.current!.consume(urlKey) === "own") return
    setFiltersState(urlFilters)
  }, [urlKey, urlFilters])

  const setFilters = React.useCallback(
    (next: TableFilters) => {
      const qs = filtersToParams(next).toString()
      echoRegistry.current!.add(qs, lastUrlKey.current)
      setFiltersState(next)
      // push creates a history entry per filter state so Back/Forward steps
      // through them; same-URL pushes are turned into no-ops by Next.js
      router.push(qs ? `/transactions?${qs}` : "/transactions", {
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
