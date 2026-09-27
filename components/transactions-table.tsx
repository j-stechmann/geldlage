"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CircleDashed,
  Plus,
  Tag,
  Columns3,
} from "lucide-react"
import { toast } from "sonner"
import { filtersToParams, type TableFilters } from "@/lib/filters"
import { resolveCategoryColor } from "@/lib/category-colors"
import { ErrorState } from "@/components/error-state"
import { cn } from "@/lib/utils"
import { apiFetch } from "@/lib/api-fetch"

interface TxRow {
  id: string
  bookingDate: string
  valueDate: string | null
  status: string
  payer: string | null
  payee: string | null
  purpose: string | null
  type: string
  counterpartyIban: string | null
  amountCents: number
  creditorId: string | null
  mandateRef: string | null
  customerRef: string | null
  accountId: number
  accountName: string | null
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  labelStatus: string
}

interface TransactionsResponse {
  rows: TxRow[]
  total: number
  page: number
  pageCount: number
}

function euro(cents: number): string {
  const abs = Math.abs(cents)
  const int = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, "0")
  return `${cents < 0 ? "−" : ""}${int.toLocaleString("de-DE")},${frac} €`
}

type SortKey = "bookingDate" | "valueDate" | "amountCents" | "payee" | "status"

const SORT_TO_FIELD: Record<SortKey, string> = {
  bookingDate: "booking_date",
  valueDate: "value_date",
  amountCents: "amount_cents",
  payee: "payee",
  status: "status",
}

type ColumnKey =
  | "bookingDate"
  | "valueDate"
  | "status"
  | "counterparty"
  | "purpose"
  | "counterpartyIban"
  | "type"
  | "account"
  | "category"
  | "creditorId"
  | "mandateRef"
  | "customerRef"
  | "labelStatus"
  | "amountCents"

const COLUMNS: Array<{ key: ColumnKey; label: string; defaultOn: boolean }> = [
  { key: "bookingDate", label: "Buchung", defaultOn: true },
  { key: "valueDate", label: "Wertstellung", defaultOn: false },
  { key: "status", label: "Status", defaultOn: false },
  { key: "counterparty", label: "Vertragspartner", defaultOn: true },
  { key: "purpose", label: "Verwendungszweck", defaultOn: true },
  { key: "counterpartyIban", label: "IBAN", defaultOn: false },
  { key: "type", label: "Typ", defaultOn: true },
  { key: "account", label: "Konto", defaultOn: true },
  { key: "category", label: "Kategorie", defaultOn: true },
  { key: "labelStatus", label: "Label-Status", defaultOn: false },
  { key: "creditorId", label: "Gläubiger-ID", defaultOn: false },
  { key: "mandateRef", label: "Mandatsreferenz", defaultOn: false },
  { key: "customerRef", label: "Kundenreferenz", defaultOn: false },
  { key: "amountCents", label: "Betrag", defaultOn: true },
]

const DEFAULT_VISIBLE = COLUMNS.filter((c) => c.defaultOn).map((c) => c.key)

const STORAGE_KEY = "geldlage.table.columns"

function loadVisible(): ColumnKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_VISIBLE
    const parsed = JSON.parse(raw) as ColumnKey[]
    const valid = parsed.filter((k) => COLUMNS.some((c) => c.key === k))
    return valid.length > 0 ? valid : DEFAULT_VISIBLE
  } catch {
    return DEFAULT_VISIBLE
  }
}

function CategoryCell({ row }: { row: TxRow }) {
  if (row.labelStatus === "pending") {
    return (
      <Badge
        variant="outline"
        className="gap-1 font-normal text-muted-foreground"
      >
        <CircleDashed className="size-3" /> wird kategorisiert
      </Badge>
    )
  }
  if (row.labelStatus === "failed" || !row.categoryName) {
    return (
      <Badge
        variant="outline"
        className="gap-1 font-normal text-muted-foreground"
      >
        <Tag className="size-3" /> ohne Kategorie
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="category-badge font-normal"
      style={
        {
          "--category-color": resolveCategoryColor(
            row.categoryId,
            row.categoryColor
          ),
        } as React.CSSProperties
      }
    >
      {row.categoryName}
    </Badge>
  )
}

function LabelStatusCell({ status }: { status: string }) {
  if (status === "pending") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        offen
      </Badge>
    )
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="font-normal text-destructive">
        fehlgeschlagen
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      gelabelt
    </Badge>
  )
}

interface LabelOption {
  id: number
  name: string
  origin: string
  color: string | null
}

function AssignLabelDialog({
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

function SortHeader({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string
  sortKey: SortKey
  sort: { key: SortKey; desc: boolean }
  onToggle: (key: SortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    <button
      className={`flex items-center gap-1 font-medium ${active ? "text-foreground" : "hover:text-foreground"}`}
      onClick={() => onToggle(sortKey)}
    >
      {label}
      {active ? (
        sort.desc ? (
          <ArrowDown className="size-3" />
        ) : (
          <ArrowUp className="size-3" />
        )
      ) : (
        <ArrowUpDown className="size-3 opacity-50" />
      )}
    </button>
  )
}

export function TransactionsTable({ filters }: { filters: TableFilters }) {
  const [page, setPage] = React.useState(1)
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({
    key: "bookingDate",
    desc: true,
  })
  const [assignTarget, setAssignTarget] = React.useState<TxRow | null>(null)
  const [visible, setVisible] = React.useState<ColumnKey[] | null>(() =>
    typeof window === "undefined" ? null : loadVisible()
  )
  const effectiveVisible = visible ?? DEFAULT_VISIBLE

  const toggleColumn = (key: ColumnKey) => {
    const prev = effectiveVisible
    const next = prev.includes(key)
      ? prev.filter((k) => k !== key)
      : [
          ...COLUMNS.map((c) => c.key).filter(
            (k) => prev.includes(k) || k === key
          ),
        ]
    if (next.length === 0) return
    setVisible(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // ignore persistence failures
    }
  }

  const params = React.useMemo(() => {
    const sp = filtersToParams(filters)
    sp.set("page", String(page))
    sp.set("pageSize", "25")
    sp.set("sort", SORT_TO_FIELD[sort.key])
    sp.set("dir", sort.desc ? "desc" : "asc")
    return sp
  }, [filters, page, sort])

  // value-based identity: page/reset must not fire on page changes
  const filterKey = React.useMemo(
    () => filtersToParams(filters).toString(),
    [filters]
  )
  const [lastFilterKey, setLastFilterKey] = React.useState(filterKey)
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey)
    setPage(1)
  }

  const { data, isLoading, isFetching, isError, refetch } =
    useQuery<TransactionsResponse>({
      queryKey: ["transactions", params.toString()],
      queryFn: async () => {
        const res = await apiFetch(`/api/transactions?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      },
      placeholderData: (prev) => prev,
    })

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }
    )
    setPage(1)
  }

  const rows = data?.rows ?? []
  const show = (key: ColumnKey) => effectiveVisible.includes(key)
  const visibleCount = COLUMNS.filter((c) => show(c.key)).length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                <Columns3 className="size-4" /> Spalten
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Spalten anzeigen</DropdownMenuLabel>
              {COLUMNS.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={show(c.key)}
                  onCheckedChange={() => toggleColumn(c.key)}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        className={`overflow-x-auto rounded-lg border transition-opacity ${isFetching ? "opacity-70" : ""}`}
      >
        <Table>
          <TableHeader>
            <TableRow>
              {show("bookingDate") && (
                <TableHead>
                  <SortHeader
                    label="Buchung"
                    sortKey="bookingDate"
                    sort={sort}
                    onToggle={toggleSort}
                  />
                </TableHead>
              )}
              {show("valueDate") && (
                <TableHead>
                  <SortHeader
                    label="Wertstellung"
                    sortKey="valueDate"
                    sort={sort}
                    onToggle={toggleSort}
                  />
                </TableHead>
              )}
              {show("status") && (
                <TableHead>
                  <SortHeader
                    label="Status"
                    sortKey="status"
                    sort={sort}
                    onToggle={toggleSort}
                  />
                </TableHead>
              )}
              {show("counterparty") && (
                <TableHead>
                  <SortHeader
                    label="Vertragspartner"
                    sortKey="payee"
                    sort={sort}
                    onToggle={toggleSort}
                  />
                </TableHead>
              )}
              {show("purpose") && <TableHead>Verwendungszweck</TableHead>}
              {show("counterpartyIban") && <TableHead>IBAN</TableHead>}
              {show("type") && <TableHead>Typ</TableHead>}
              {show("account") && <TableHead>Konto</TableHead>}
              {show("category") && <TableHead>Kategorie</TableHead>}
              {show("labelStatus") && <TableHead>Label-Status</TableHead>}
              {show("creditorId") && <TableHead>Gläubiger-ID</TableHead>}
              {show("mandateRef") && <TableHead>Mandatsreferenz</TableHead>}
              {show("customerRef") && <TableHead>Kundenreferenz</TableHead>}
              {show("amountCents") && (
                <TableHead className="text-right">
                  <SortHeader
                    label="Betrag"
                    sortKey="amountCents"
                    sort={sort}
                    onToggle={toggleSort}
                  />
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && rows.length === 0 ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: visibleCount }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={visibleCount} className="h-32">
                  <ErrorState
                    onRetry={() => void refetch()}
                    className="justify-center border-none bg-transparent"
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={visibleCount}
                  className="h-32 text-center text-muted-foreground"
                >
                  Keine Transaktionen gefunden. CSV-Datei in das Fenster ziehen,
                  um zu importieren.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const counterparty =
                  row.type === "Ausgang" ? row.payee : row.payer
                return (
                  <TableRow key={row.id}>
                    {show("bookingDate") && (
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {row.bookingDate}
                      </TableCell>
                    )}
                    {show("valueDate") && (
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {row.valueDate ?? "—"}
                      </TableCell>
                    )}
                    {show("status") && (
                      <TableCell className="whitespace-nowrap">
                        {row.status}
                      </TableCell>
                    )}
                    {show("counterparty") && (
                      <TableCell>
                        <div className="max-w-md min-w-0">
                          <p className="truncate font-medium">
                            {counterparty || "—"}
                          </p>
                        </div>
                      </TableCell>
                    )}
                    {show("purpose") && (
                      <TableCell>
                        <p
                          className="max-w-md truncate text-sm text-muted-foreground"
                          title={row.purpose ?? undefined}
                        >
                          {row.purpose || "—"}
                        </p>
                      </TableCell>
                    )}
                    {show("counterpartyIban") && (
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {row.counterpartyIban || "—"}
                      </TableCell>
                    )}
                    {show("type") && (
                      <TableCell className="whitespace-nowrap">
                        {row.type}
                      </TableCell>
                    )}
                    {show("account") && (
                      <TableCell className="whitespace-nowrap">
                        {row.accountName ?? "—"}
                      </TableCell>
                    )}
                    {show("category") && (
                      <TableCell>
                        <button
                          className="inline-flex cursor-pointer items-center rounded-md transition-colors hover:bg-accent/60"
                          onClick={() => setAssignTarget(row)}
                          title="Kategorie zuweisen"
                        >
                          <CategoryCell row={row} />
                        </button>
                      </TableCell>
                    )}
                    {show("labelStatus") && (
                      <TableCell className="whitespace-nowrap">
                        <LabelStatusCell status={row.labelStatus} />
                      </TableCell>
                    )}
                    {show("creditorId") && (
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {row.creditorId || "—"}
                      </TableCell>
                    )}
                    {show("mandateRef") && (
                      <TableCell className="max-w-40 truncate font-mono text-xs">
                        {row.mandateRef || "—"}
                      </TableCell>
                    )}
                    {show("customerRef") && (
                      <TableCell className="max-w-40 truncate font-mono text-xs">
                        {row.customerRef || "—"}
                      </TableCell>
                    )}
                    {show("amountCents") && (
                      <TableCell
                        className={`text-right font-medium whitespace-nowrap tabular-nums ${
                          row.amountCents < 0
                            ? "text-foreground"
                            : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {euro(row.amountCents)}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {data ? `${data.total.toLocaleString("de-DE")} Transaktionen` : "…"}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" /> Zurück
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            {page} / {data?.pageCount ?? 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= (data?.pageCount ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Weiter <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {assignTarget && (
        <AssignLabelDialog
          row={assignTarget}
          onClose={() => setAssignTarget(null)}
        />
      )}
    </div>
  )
}
