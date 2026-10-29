"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
} from "lucide-react"
import { filtersToParams, type TableFilters } from "@/lib/filters"
import { ErrorState } from "@/components/error-state"
import { apiFetch } from "@/lib/api-fetch"
import {
  COLUMNS,
  toggleColumn,
  useVisibleColumns,
  type ColumnKey,
} from "@/components/table-columns"
import {
  TransactionDetailRow,
  TransactionRow,
  planPrefillFromTx,
  type TxRow,
} from "@/components/transaction-row"
import { PlanDialog } from "@/components/planning/plan-dialog"
import type { PlanRow } from "@/components/planning/api"
import { AssignLabelDialog } from "@/components/assign-label-dialog"
import { useRowActivation } from "@/hooks/use-row-activation"

interface TransactionsResponse {
  rows: TxRow[]
  total: number
  page: number
  pageCount: number
}

type SortKey = "bookingDate" | "valueDate" | "amountCents" | "payee" | "status"

const SORT_TO_FIELD: Record<SortKey, string> = {
  bookingDate: "booking_date",
  valueDate: "value_date",
  amountCents: "amount_cents",
  payee: "payee",
  status: "status",
}

const SORT_LABELS: Record<SortKey, string> = {
  bookingDate: "Buchung",
  valueDate: "Wertstellung",
  amountCents: "Betrag",
  payee: "Vertragspartner",
  status: "Status",
}

function SortHeader({
  label,
  sortKey,
  sort,
  onToggle,
  disabled = false,
}: {
  label: string
  sortKey: SortKey
  sort: { key: SortKey; desc: boolean }
  onToggle: (key: SortKey) => void
  /** deep-link focus mode: the id lookup ignores every sort — dead control */
  disabled?: boolean
}) {
  const active = sort.key === sortKey
  return (
    <button
      className={`flex items-center gap-1 font-medium disabled:cursor-not-allowed disabled:opacity-50 ${active ? "text-foreground" : "hover:text-foreground"}`}
      onClick={() => onToggle(sortKey)}
      disabled={disabled}
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

// canonical order of the sort dropdown
const DEFAULT_SORTABLE: SortKey[] = [
  "bookingDate",
  "valueDate",
  "status",
  "payee",
  "amountCents",
]

export function TransactionsTable({
  filters,
  focusTxId,
}: {
  filters: TableFilters
  /** deep-linked transaction (from /planung): expanded + highlighted */
  focusTxId?: string | null
}) {
  const [page, setPage] = React.useState(1)
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({
    key: "bookingDate",
    desc: true,
  })
  const [assignTarget, setAssignTarget] = React.useState<TxRow | null>(null)
  // convert-to-plan target: the plan dialog opens pre-filled from this row
  const [converting, setConverting] = React.useState<TxRow | null>(null)
  // matched-plan edit target: "Plan bearbeiten" opens the plan dialog in
  // edit mode for the plan the row is already read-time matched to
  const [editingPlan, setEditingPlan] = React.useState<PlanRow | null>(null)
  // one expanded detail row at a time (accordion); collapses on context
  // changes via the value-based reset below
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  // column visibility lives in the external store (components/table-columns.ts)
  const visibleColumns = useVisibleColumns()
  const visibleSet = React.useMemo(
    () => new Set<ColumnKey>(visibleColumns),
    [visibleColumns]
  )
  const show = (key: ColumnKey) => visibleSet.has(key)
  // data columns + the expansion toggle column: cell count for skeleton,
  // empty/error, and detail rows
  const totalColumns = COLUMNS.filter((c) => show(c.key)).length + 1

  // stable handlers so memoized rows can skip re-renders
  const toggleExpandedRow = React.useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])
  const openAssignDialog = React.useCallback((row: TxRow) => {
    setAssignTarget(row)
  }, [])
  const openConvertDialog = React.useCallback((row: TxRow) => {
    setConverting(row)
  }, [])
  const openEditPlanDialog = React.useCallback((plan: PlanRow) => {
    setEditingPlan(plan)
  }, [])
  const activation = useRowActivation()

  // normalize ONCE, mirroring the server's id lookup (`sp.get("id")?.trim()`
  // — app/api/transactions/route.ts): a hand-edited URL with padded
  // whitespace ("?tx=<id>%20") would otherwise still fetch the right row
  // (the server trims) but fail the row.id match further below, leaving the
  // highlight/expansion silently dead. Generated deep links
  // (transactionDeepLink) never carry whitespace; the trim also keeps a
  // whitespace-only param falling back to the filter pipeline exactly as
  // the server does.
  const focusId = focusTxId?.trim() || null

  // deep-link focus mode: the id lookup intentionally ignores filters, sort
  // and pagination — keep the dead controls visibly off and label the state
  const focusMode = Boolean(focusId)

  const params = React.useMemo(() => {
    // deep-linked focus (from /planung): the query fetches exactly the one
    // row via the id lookup, independent of any filter state
    if (focusId) {
      return new URLSearchParams({ id: focusId, page: "1", pageSize: "25" })
    }
    const sp = filtersToParams(filters)
    sp.set("page", String(page))
    sp.set("pageSize", "25")
    sp.set("sort", SORT_TO_FIELD[sort.key])
    sp.set("dir", sort.desc ? "desc" : "asc")
    return sp
  }, [filters, page, sort, focusId])

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

  // collapse the detail row when the listing context changes — but NOT while
  // focus mode is active: the id lookup ignores page/sort/filters entirely,
  // and a deep link to ?tx=<id> almost always clears the filters, whose
  // mirrored state the page adopts in an effect one commit AFTER the focus
  // param arrives (the table stays mounted for in-place URL transitions).
  // The ungated reset would wipe in that trailing commit the expansion the
  // focus sync below just applied.
  const expandContext = React.useMemo(
    () => [page, sort.key, sort.desc, filterKey].join("|"),
    [page, sort, filterKey]
  )
  const [lastExpandContext, setLastExpandContext] =
    React.useState(expandContext)
  if (lastExpandContext !== expandContext) {
    setLastExpandContext(expandContext)
    if (!focusId) setExpandedId(null)
  }

  // deep-link focus (from the /planung calendar): expand the row during
  // render — after the context reset above (gated off while focused).
  // lastFocus init null so the FIRST value also fires (mount is a legitimate
  // focus event); a transition TO null (a filter edit dropping the tx param)
  // clears the expansion here so the previously focused row cannot leak
  // into the following listing.
  const [lastFocusTxId, setLastFocusTxId] = React.useState<string | null>(null)
  if (focusId !== lastFocusTxId) {
    setLastFocusTxId(focusId)
    if (focusId) setExpandedId(focusId)
    else setExpandedId(null)
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {focusMode && (
          <Badge variant="secondary" className="mr-auto font-normal">
            Fokus-Ansicht: nur diese Transaktion — Filteränderung kehrt zur
            Liste zurück
          </Badge>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" disabled={focusMode}>
                <ArrowUpDown className="size-4" /> Sortierung
                <span className="text-muted-foreground">
                  {SORT_LABELS[sort.key]}
                </span>
                {sort.desc ? (
                  <ArrowDown className="size-3.5 text-muted-foreground" />
                ) : (
                  <ArrowUp className="size-3.5 text-muted-foreground" />
                )}
              </Button>
            }
          />
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={sort.key}
              onValueChange={(v) => {
                setSort({ key: v as SortKey, desc: true })
                setPage(1)
              }}
            >
              {DEFAULT_SORTABLE.map((key) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setSort((prev) => ({ ...prev, desc: !prev.desc }))
              }}
            >
              {sort.desc ? (
                <ArrowUp className="size-4" />
              ) : (
                <ArrowDown className="size-4" />
              )}
              {sort.desc ? "Aufsteigend sortieren" : "Absteigend sortieren"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
              <TableHead className="w-8">
                <span className="sr-only">Details einblenden</span>
              </TableHead>
              {show("bookingDate") && (
                <TableHead>
                  <SortHeader
                    label="Buchung"
                    sortKey="bookingDate"
                    sort={sort}
                    onToggle={toggleSort}
                    disabled={focusMode}
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
                    disabled={focusMode}
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
                    disabled={focusMode}
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
                    disabled={focusMode}
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
                    disabled={focusMode}
                  />
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && rows.length === 0 ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: totalColumns }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={totalColumns} className="h-32">
                  <ErrorState
                    onRetry={() => void refetch()}
                    className="justify-center border-none bg-transparent"
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={totalColumns}
                  className="h-32 text-center text-muted-foreground"
                >
                  {focusMode
                    ? // deep-link miss: the calendar's bank chip pointed at a
                      // row that is gone (deleted, or a stale id) — a generic
                      // "no data" message would read like the list itself is
                      // empty
                      "Transaktion nicht gefunden (ggf. gelöscht). Eine Filteränderung kehrt zur Liste zurück."
                    : "Keine Transaktionen gefunden. CSV-Datei in das Fenster ziehen, um zu importieren."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const isExpanded = expandedId === row.id
                return (
                  <React.Fragment key={row.id}>
                    <TransactionRow
                      row={row}
                      expanded={isExpanded}
                      visibleSet={visibleSet}
                      activation={activation}
                      onToggle={toggleExpandedRow}
                      onAssign={openAssignDialog}
                      focus={focusId != null && row.id === focusId}
                    />
                    {isExpanded && (
                      <TransactionDetailRow
                        row={row}
                        colSpan={totalColumns}
                        onConvertToPlan={openConvertDialog}
                        onEditPlan={openEditPlanDialog}
                      />
                    )}
                  </React.Fragment>
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
            disabled={focusMode || page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" /> Zurück
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            {/* focus mode ignores the page state entirely (the id lookup is a
                single row): the pager must not offer dead controls — the
                buttons disable and the stale "N / 1" indicator reads "Fokus" */}
            {focusMode ? "Fokus" : `${page} / ${data?.pageCount ?? 1}`}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={focusMode || page >= (data?.pageCount ?? 1)}
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

      {converting && (
        <PlanDialog
          open
          onOpenChange={(open) => {
            if (!open) setConverting(null)
          }}
          prefill={planPrefillFromTx(converting)}
        />
      )}

      {editingPlan && (
        <PlanDialog
          open
          plan={editingPlan}
          onOpenChange={(open) => {
            if (!open) setEditingPlan(null)
          }}
        />
      )}
    </div>
  )
}
