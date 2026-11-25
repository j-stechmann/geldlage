"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api-fetch"

export interface ImportBatchState {
  id: string
  fileName: string
  status: "parsing" | "importing" | "labeling" | "completed" | "failed"
  error: string | null
  rowsTotal: number
  rowsImported: number
  rowsDuplicate: number
  rowsUpdated: number
  labelsTotal: number
  labelsDone: number
  labelsFailed: number
  createdAt: string
}

interface ActiveImportContextValue {
  activeBatchId: string | null
  batch: ImportBatchState | null
  startPolling: (batchId: string) => void
  clearActive: () => void
}

const ActiveImportContext = React.createContext<ActiveImportContextValue>({
  activeBatchId: null,
  batch: null,
  startPolling: () => {},
  clearActive: () => {},
})

export function useActiveImport() {
  return React.useContext(ActiveImportContext)
}

/**
 * Tracks the most recent import batch: polls /api/imports/[id] every second
 * while it is in a non-terminal state, invalidates analytics queries on
 * completion, and keeps the last terminal state visible until dismissed.
 */
export function ActiveImportProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [activeBatchId, setActiveBatchId] = React.useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: batch } = useQuery<ImportBatchState | null>({
    queryKey: ["import", activeBatchId],
    enabled: activeBatchId !== null,
    queryFn: async () => {
      const res = await apiFetch(`/api/imports/${activeBatchId}`)
      if (!res.ok) return null
      return (await res.json()) as ImportBatchState
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === "completed" || status === "failed" ? false : 1000
    },
  })

  const prevStatus = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!batch) return
    if (batch.status === "completed" && prevStatus.current !== "completed") {
      toast.success("Import abgeschlossen", {
        description: `${batch.rowsImported} neu, ${batch.rowsDuplicate} Duplikate${
          batch.rowsUpdated > 0 ? `, ${batch.rowsUpdated} aktualisiert` : ""
        } (${batch.fileName})`,
      })
      void queryClient.invalidateQueries({ queryKey: ["analytics"] })
      void queryClient.invalidateQueries({ queryKey: ["transactions"] })
      void queryClient.invalidateQueries({ queryKey: ["categories"] })
      void queryClient.invalidateQueries({ queryKey: ["labels"] })
      void queryClient.invalidateQueries({ queryKey: ["prediction"] })
    }
    if (batch.status === "failed" && prevStatus.current !== "failed") {
      toast.error("Import fehlgeschlagen", {
        description: batch.error ?? batch.fileName,
      })
      void queryClient.invalidateQueries({ queryKey: ["imports"] })
    }
    prevStatus.current = batch.status
  }, [batch, queryClient])

  const startPolling = React.useCallback((batchId: string) => {
    setActiveBatchId(batchId)
  }, [])

  const clearActive = React.useCallback(() => {
    setActiveBatchId(null)
  }, [])

  const value = React.useMemo(
    () => ({ activeBatchId, batch: batch ?? null, startPolling, clearActive }),
    [activeBatchId, batch, startPolling, clearActive]
  )

  return (
    <ActiveImportContext.Provider value={value}>
      {children}
    </ActiveImportContext.Provider>
  )
}
