"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { apiFetch } from "@/lib/api-fetch"
import { cn } from "@/lib/utils"
import { resolveCategoryColor } from "@/lib/category-colors"
import type { TxRow } from "@/components/transaction-row"

interface LabelOption {
  id: number
  name: string
  origin: string
  color: string | null
}

/**
 * Label assignment dialog: clicking a category cell opens a searchable label
 * list — single click selects, double-click assigns instantly; a
 * "…neu erstellen und zuweisen" action POSTs `{labelName}` (the server
 * creates the category and learns a rule in the same request).
 */
export function AssignLabelDialog({
  row,
  onClose,
}: {
  row: TxRow
  onClose: () => void
}) {
  const [search, setSearch] = React.useState("")
  const [selectedId, setSelectedId] = React.useState<number | null>(
    row.categoryId
  )
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const { data } = useQuery<{ labels: LabelOption[] }>({
    queryKey: ["labels"],
    queryFn: async () => {
      const res = await apiFetch("/api/labels")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })

  const labels = (data?.labels ?? []).filter((l) =>
    l.name.toLowerCase().includes(search.toLowerCase())
  )
  const exactMatch = (data?.labels ?? []).find(
    (l) => l.name.toLowerCase() === search.trim().toLowerCase()
  )
  const selected = (data?.labels ?? []).find((l) => l.id === selectedId)

  const toastError = (title: string, err: unknown) =>
    toast.error(title, {
      description: err instanceof Error ? err.message : "Netzwerkfehler",
    })

  const assign = async (labelId?: number) => {
    if (busy) return
    const id = labelId ?? selectedId
    if (!id) return
    setBusy(true)
    try {
      const res = await apiFetch(`/api/transactions/${row.id}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelId: id }),
      })
      const data2 = (await res.json()) as { error?: string; message?: string }
      if (res.ok) {
        toast.success("Kategorie zugewiesen", {
          description: `Regel für ${row.type === "Ausgang" ? (row.payee ?? "Vertragspartner") : (row.payer ?? "Vertragspartner")} gelernt.`,
        })
        void queryClient.invalidateQueries({ queryKey: ["transactions"] })
        void queryClient.invalidateQueries({ queryKey: ["analytics"] })
        void queryClient.invalidateQueries({ queryKey: ["categories"] })
        void queryClient.invalidateQueries({ queryKey: ["labels"] })
        onClose()
      } else {
        toast.error("Zuweisung fehlgeschlagen", {
          description: data2.message ?? data2.error ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toastError("Zuweisung fehlgeschlagen", err)
    } finally {
      setBusy(false)
    }
  }

  const createAndAssign = async () => {
    if (busy) return
    if (!search.trim() || exactMatch) return
    setBusy(true)
    try {
      const res = await apiFetch(`/api/transactions/${row.id}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelName: search.trim() }),
      })
      const data2 = (await res.json()) as { error?: string; message?: string }
      if (res.ok) {
        toast.success(`Label "${search.trim()}" erstellt und zugewiesen`)
        void queryClient.invalidateQueries({ queryKey: ["transactions"] })
        void queryClient.invalidateQueries({ queryKey: ["analytics"] })
        void queryClient.invalidateQueries({ queryKey: ["categories"] })
        void queryClient.invalidateQueries({ queryKey: ["labels"] })
        onClose()
      } else {
        toast.error("Erstellen fehlgeschlagen", {
          description: data2.message ?? data2.error ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toastError("Erstellen fehlgeschlagen", err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kategorie zuweisen</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Label suchen oder neu erstellen…"
          value={search}
          autoFocus
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {labels.map((label) => (
            <button
              key={label.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                selectedId === label.id && "border-primary bg-accent",
                busy && "pointer-events-none opacity-50"
              )}
              onClick={() => setSelectedId(label.id)}
              onDoubleClick={() => void assign(label.id)}
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={
                  {
                    "--category-color": resolveCategoryColor(
                      label.id,
                      label.color
                    ),
                  } as React.CSSProperties
                }
              />
              <span className="truncate">{label.name}</span>
              {label.origin === "llm" && (
                <span className="ml-auto text-xs text-muted-foreground">
                  erfunden
                </span>
              )}
            </button>
          ))}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {search.trim() && !exactMatch && (
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void createAndAssign()}
            >
              <Plus className="size-4" /> &quot;{search.trim()}&quot; neu
              erstellen und zuweisen
            </Button>
          )}
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button
              disabled={busy || !selectedId}
              onClick={() => void assign()}
            >
              {selected ? `Zuweisen: ${selected.name}` : "Zuweisen"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
