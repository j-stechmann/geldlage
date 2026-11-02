"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ChevronLeft,
  ChevronRight,
  CircleStop,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PlanDialog } from "@/components/planning/plan-dialog"
import { ErrorState } from "@/components/error-state"
import {
  deletePlan,
  describeRrule,
  germanDate,
  invalidatePlans,
  setPlanStatus,
  usePlansPage,
  type PlanListFilters,
  type PlanRow,
  type PlanStatusFilter,
} from "@/components/planning/api"
import { euro } from "@/lib/money"
import { resolveCategoryColor } from "@/lib/category-colors"

const PAGE_SIZE = 20
const COLUMN_COUNT = 8

function StatusBadge({ status }: { status: PlanRow["status"] }) {
  if (status === "active") {
    return <Badge className="font-normal">Aktiv</Badge>
  }
  if (status === "paused") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        Pausiert
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      Beendet
    </Badge>
  )
}

function planTitle(plan: PlanRow): string {
  return plan.counterparty ?? plan.purpose ?? "Geplante Transaktion"
}

function PlanName({ plan }: { plan: PlanRow }) {
  const title = planTitle(plan)
  // only show a second line when it carries information the title doesn't
  const subtitle =
    plan.counterparty !== null && plan.purpose !== null
      ? plan.purpose
      : plan.notes
  return (
    <div className="max-w-64 min-w-0">
      <p className="truncate text-sm font-medium">{title}</p>
      {subtitle ? (
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  )
}

function PlanActions({
  plan,
  busy,
  disabled,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  plan: PlanRow
  busy: boolean
  /** rows from a failed background refetch must not be actionable */
  disabled?: boolean
  onEdit: (plan: PlanRow) => void
  onToggleStatus: (
    plan: PlanRow,
    forced?: "active" | "paused" | "finished"
  ) => void
  onDelete: (plan: PlanRow) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Aktionen für ${planTitle(plan)}`}
            disabled={busy || disabled}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onEdit(plan)}>
          <Pencil />
          Bearbeiten
        </DropdownMenuItem>
        {plan.status === "active" && (
          <DropdownMenuItem onClick={() => onToggleStatus(plan)}>
            <Pause />
            Pausieren
          </DropdownMenuItem>
        )}
        {plan.status === "paused" && (
          <DropdownMenuItem onClick={() => onToggleStatus(plan)}>
            <Play />
            Aktivieren
          </DropdownMenuItem>
        )}
        {plan.status === "finished" && (
          <DropdownMenuItem onClick={() => onToggleStatus(plan, "active")}>
            <Play />
            Reaktivieren
          </DropdownMenuItem>
        )}
        {plan.status !== "finished" && (
          <DropdownMenuItem onClick={() => onToggleStatus(plan, "finished")}>
            <CircleStop />
            Beenden
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(plan)}>
          <Trash2 />
          Löschen
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * /plans — the plan CRUD list. Search, status filter, and paging are all
 * server-side (the same contract as the transactions table); the client
 * only serializes its state into the query string. `nextDueDate` is computed
 * by the API for the returned page only.
 */
export function PlansList() {
  const queryClient = useQueryClient()
  const [qDraft, setQDraft] = React.useState("")
  const [q, setQ] = React.useState("")
  const [status, setStatus] = React.useState<PlanStatusFilter>("all")
  const [page, setPage] = React.useState(1)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<PlanRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<PlanRow | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  // debounce the text input, emitting the trimmed value so the URL/query
  // key does not churn on trailing whitespace (the transactions FilterBar
  // pattern)
  React.useEffect(() => {
    const t = setTimeout(() => setQ(qDraft.trim()), 300)
    return () => clearTimeout(t)
  }, [qDraft])

  const filters: PlanListFilters = { q, status }
  const filterKey = `${q}\u0000${status}`

  // value-based filter reset (render-time, same as the transactions table):
  // page changes alone must not re-fire this
  const [lastFilterKey, setLastFilterKey] = React.useState(filterKey)
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey)
    setPage(1)
  }

  const plansQuery = usePlansPage(filters, page, PAGE_SIZE)
  const pageCount = plansQuery.data?.pageCount ?? 1

  // a delete on the last page can leave it out of range — follow the server's
  // pageCount instead of rendering a permanently empty page (render-time
  // adjustment, the same value-based pattern as the filter reset above; an
  // effect here would be a cascading setState)
  const [lastPageCount, setLastPageCount] = React.useState(pageCount)
  if (plansQuery.data && lastPageCount !== pageCount) {
    setLastPageCount(pageCount)
    if (page > pageCount) setPage(pageCount)
  }

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (plan: PlanRow) => {
    setEditing(plan)
    setDialogOpen(true)
  }

  // a successful create is the newest row, i.e. page 1; editing and
  // cancelling keep the current page so the list does not jump underfoot
  const handleSaved = (created: boolean) => {
    if (created) setPage(1)
  }

  const toastError = (title: string, err: unknown) =>
    toast.error(title, {
      description: err instanceof Error ? err.message : "Netzwerkfehler",
    })

  const toggleStatus = (
    plan: PlanRow,
    forced?: "active" | "paused" | "finished"
  ) => {
    const next = forced ?? (plan.status === "active" ? "paused" : "active")
    setBusyId(plan.id)
    void setPlanStatus(plan.id, next)
      .then(() => {
        toast.success(
          next === "paused"
            ? "Plan pausiert"
            : next === "finished"
              ? "Plan beendet"
              : "Plan aktiviert"
        )
        invalidatePlans(queryClient)
      })
      .catch((err) => toastError("Statuswechsel fehlgeschlagen", err))
      .finally(() => setBusyId(null))
  }

  const confirmDelete = () => {
    if (!deleting) return
    setDeleteBusy(true)
    void deletePlan(deleting.id)
      .then(() => {
        toast.success("Plan gelöscht")
        setDeleting(null)
        invalidatePlans(queryClient)
      })
      .catch((err) => toastError("Löschen fehlgeschlagen", err))
      .finally(() => setDeleteBusy(false))
  }

  const data = plansQuery.data
  const rows = data?.plans ?? []
  const filtered = q !== "" || status !== "all"

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Suchen (Empfänger, Zweck, Notizen, Konto, Kategorie)…"
            aria-label="Pläne durchsuchen"
            className="pl-8"
          />
        </div>

        <Select
          items={{
            all: "Alle Status",
            active: "Aktiv",
            paused: "Pausiert",
            finished: "Beendet",
          }}
          value={status}
          onValueChange={(v) => setStatus(String(v) as PlanStatusFilter)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Status</SelectItem>
            <SelectItem value="active">Aktiv</SelectItem>
            <SelectItem value="paused">Pausiert</SelectItem>
            <SelectItem value="finished">Beendet</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="icon"
          title="Suche und Filter zurücksetzen"
          aria-label="Suche und Filter zurücksetzen"
          onClick={() => {
            setQDraft("")
            setStatus("all")
          }}
        >
          <RotateCcw className="size-4" />
        </Button>

        <Button onClick={openCreate} size="sm">
          <Plus data-icon="inline-start" />
          Plan anlegen
        </Button>
      </div>

      {/* A background refetch (invalidate after delete/status change) can
          fail while React Query still serves the last successful page — that
          must not read as success. The tbody branch below covers the
          no-cached-rows case; this banner keeps the failure visible when
          stale rows remain. */}
      {plansQuery.isError && rows.length > 0 && (
        <ErrorState onRetry={() => void plansQuery.refetch()} />
      )}

      <div
        className={`overflow-hidden rounded-lg border transition-opacity ${plansQuery.isFetching ? "opacity-70" : ""}`}
      >
        <Table
          containerClassName="max-h-[65vh] overflow-y-auto"
          className="min-w-[860px]"
        >
          <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background">
            <TableRow>
              <TableHead>Bezeichnung</TableHead>
              <TableHead>Kategorie</TableHead>
              <TableHead>Konto</TableHead>
              <TableHead className="text-right">Betrag</TableHead>
              <TableHead>Wiederholung</TableHead>
              <TableHead>Nächster Termin</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Aktionen</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plansQuery.isError && rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT} className="h-32">
                  <ErrorState
                    onRetry={() => void plansQuery.refetch()}
                    className="justify-center border-none bg-transparent"
                  />
                </TableCell>
              </TableRow>
            ) : plansQuery.isLoading && rows.length === 0 ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: COLUMN_COUNT }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="h-32 text-center text-muted-foreground"
                >
                  {filtered
                    ? "Keine Pläne gefunden."
                    : "Noch keine Pläne angelegt. Legen Sie Ihren ersten Plan an."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((plan) => {
                const busy = busyId === plan.id
                return (
                  <TableRow
                    key={plan.id}
                    className={plan.status === "finished" ? "opacity-70" : ""}
                  >
                    <TableCell>
                      <PlanName plan={plan} />
                    </TableCell>
                    <TableCell>
                      {plan.categoryName ? (
                        <Badge
                          variant="outline"
                          className="category-badge font-normal"
                          style={
                            {
                              "--category-color": resolveCategoryColor(
                                plan.categoryId,
                                plan.categoryColor
                              ),
                            } as React.CSSProperties
                          }
                        >
                          {plan.categoryName}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {plan.accountName ?? "Alle Konten"}
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium tabular-nums ${
                        plan.amountCents < 0 ? "" : "text-primary"
                      }`}
                    >
                      {euro(plan.amountCents)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-normal">
                        {describeRrule(plan.rrule)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {plan.nextDueDate
                        ? germanDate(plan.nextDueDate)
                        : "Keine künftigen Termine"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={plan.status} />
                    </TableCell>
                    <TableCell>
                      <PlanActions
                        plan={plan}
                        busy={busy}
                        disabled={plansQuery.isError}
                        onEdit={openEdit}
                        onToggleStatus={toggleStatus}
                        onDelete={setDeleting}
                      />
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {data
            ? `${data.total.toLocaleString("de-DE")} ${data.total === 1 ? "Plan" : "Pläne"}`
            : "…"}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" />
            Zurück
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Weiter
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <PlanDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={handleSaved}
        plan={editing}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plan löschen?</DialogTitle>
            <DialogDescription>
              {deleting && (
                <>
                  &quot;{deleting.counterparty ?? deleting.purpose ?? "Plan"}
                  &quot; samt allen künftigen Terminen entfernen. Echte
                  Buchungen bleiben davon unberührt.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={deleteBusy}
            >
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteBusy}
            >
              {deleteBusy ? "Löschen…" : "Löschen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
