"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  CalendarDays,
  CircleStop,
  Pencil,
  Pause,
  Play,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PlanCalendar } from "@/components/planning/plan-calendar"
import { PlanDialog } from "@/components/planning/plan-dialog"
import {
  deletePlan,
  describeRrule,
  germanDate,
  invalidatePlans,
  setPlanStatus,
  useForecast,
  usePlans,
  type PlanOccurrence,
  type PlanRow,
} from "@/components/planning/api"
import { ErrorState } from "@/components/error-state"
import { euro } from "@/lib/money"
import { resolveCategoryColor } from "@/lib/category-colors"

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

function PlanRowCard({
  plan: basePlan,
  onEdit,
  busyId,
  onToggleStatus,
  onDelete,
}: {
  plan: PlanRow & { nextDueDate: string | null }
  onEdit: (plan: PlanRow) => void
  busyId: string | null
  onToggleStatus: (
    plan: PlanRow,
    forced?: "active" | "paused" | "finished"
  ) => void
  onDelete: (plan: PlanRow) => void
}) {
  const plan = basePlan
  const busy = busyId === plan.id
  return (
    <div
      className={`space-y-2 rounded-lg border p-3 ${plan.status === "finished" ? "opacity-70" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {plan.counterparty ?? plan.purpose ?? "Geplante Transaktion"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {germanDate(plan.dtstart)}
            {plan.accountName ? ` · ${plan.accountName}` : ""}
          </p>
        </div>
        <span
          className={`text-sm font-medium tabular-nums ${plan.amountCents < 0 ? "" : "text-primary"}`}
        >
          {euro(plan.amountCents)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {plan.categoryName && plan.categoryColor && (
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
        )}
        <StatusBadge status={plan.status} />
        <Badge variant="secondary" className="font-normal">
          {describeRrule(plan.rrule)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {plan.nextDueDate
          ? `Nächster Termin: ${germanDate(plan.nextDueDate)}`
          : "Keine künftigen Termine"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {plan.status === "active" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onToggleStatus(plan)}
          >
            <Pause data-icon="inline-start" />
            Pausieren
          </Button>
        )}
        {plan.status === "paused" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onToggleStatus(plan)}
          >
            <Play data-icon="inline-start" />
            Aktivieren
          </Button>
        )}
        {plan.status === "finished" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onToggleStatus(plan, "active")}
          >
            <Play data-icon="inline-start" />
            Reaktivieren
          </Button>
        )}
        {plan.status !== "finished" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onToggleStatus(plan, "finished")}
          >
            <CircleStop data-icon="inline-start" />
            Beenden
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onEdit(plan)}
        >
          <Pencil data-icon="inline-start" />
          Bearbeiten
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => onDelete(plan)}
        >
          <Trash2 data-icon="inline-start" />
          Löschen
        </Button>
      </div>
    </div>
  )
}

export function PlansBoard() {
  const plansQuery = usePlans()
  // unconditional on purpose: the projection card has no toggle here (the
  // dashboard gates the same query behind "Geplant einblenden") — the board
  // always shows it, so the fetch is a fixed one-request cost per visit
  // (months capped at 60 server-side, occurrences bounded by the ladder)
  const forecastQuery = useForecast(true, 12, null)
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<PlanRow | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<PlanRow | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (plan: PlanRow) => {
    setEditing(plan)
    setDialogOpen(true)
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

  const plans = plansQuery.data?.plans ?? []
  const active = plans.filter((p) => p.status !== "finished")
  const finished = plans.filter((p) => p.status === "finished")

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Kräftiger Termin = Plan · blass • = Buchung · ◌ = nicht gebucht · ✓ =
          geplant &amp; gebucht · rot = überfällig
        </p>
        <Button onClick={openCreate} size="sm">
          <Plus data-icon="inline-start" />
          Plan anlegen
        </Button>
      </div>

      <div className="grid gap-4 @min-[1024px]:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              <CalendarDays className="size-4" />
              Terminkalender
            </CardTitle>
            <CardDescription>
              Monatsübersicht oder Liste — Pläne und echte Buchungen; Plan
              klicken = bearbeiten, Buchung klicken = in Transaktionen öffnen,
              in einen Plan umwandeln oder (schon gematcht) den zugeordneten
              Plan bearbeiten.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PlanCalendar
              accountId={null}
              onEventClick={(o: PlanOccurrence) => {
                const plan = plans.find((p) => p.id === o.planId)
                if (plan) {
                  openEdit(plan)
                } else {
                  // the occurrence's plan is missing from the list — the
                  // plans data is stale (e.g. another tab mutated); re-sync
                  // instead of leaving a silently dead chip
                  void plansQuery.refetch()
                }
              }}
            />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Aktive Pläne</CardTitle>
              <CardDescription>
                {plansQuery.isError
                  ? "Pläne konnten nicht geladen werden."
                  : active.length === 0
                    ? "Noch keine Pläne angelegt."
                    : `${active.length} aktiv oder pausiert`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {plansQuery.isError ? (
                /* failed plan reads surface instead of reading as "empty" —
                   the dashboard's ErrorState pattern */
                <ErrorState
                  onRetry={() => void plansQuery.refetch()}
                  className="border-none bg-transparent px-0"
                />
              ) : active.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Miete, Gehalt, Abo? Legen Sie Ihren ersten Plan an.
                </p>
              ) : (
                active.map((plan) => (
                  <PlanRowCard
                    key={plan.id}
                    plan={plan}
                    busyId={busyId}
                    onEdit={openEdit}
                    onToggleStatus={toggleStatus}
                    onDelete={setDeleting}
                  />
                ))
              )}
            </CardContent>
          </Card>

          {(() => {
            const forecast = forecastQuery.data
            if (!forecast) {
              // a failed projection reads visibly (retryable) instead of the
              // card silently disappearing
              if (!forecastQuery.isError) return null
              return (
                <Card>
                  <CardContent>
                    <ErrorState
                      onRetry={() => void forecastQuery.refetch()}
                      className="border-none bg-transparent px-0"
                    />
                  </CardContent>
                </Card>
              )
            }
            const projected =
              forecast.projectedBalance[forecast.projectedBalance.length - 1]
                ?.balanceCents ?? null
            const plannedNet = forecast.monthlyPlanned.reduce(
              (acc, m) => acc + m.netCents,
              0
            )
            return (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Prognose (12 Monate)</CardTitle>
                  <CardDescription>
                    ab heutigem Guthaben, ohne geplante Beträge, die bereits
                    gebucht sind; pausierte Pläne zählen mit
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <div className="flex items-baseline justify-between">
                    <span className="text-muted-foreground">
                      Guthaben heute
                    </span>
                    <span className="tabular-nums">
                      {euro(forecast.startingBalanceCents)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-muted-foreground">
                      Projektion zum {germanDate(forecast.horizon.to)}
                    </span>
                    <span className="font-medium tabular-nums">
                      {euro(projected)}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-muted-foreground">
                      Geplant netto über Horizont
                    </span>
                    <span className="tabular-nums">{euro(plannedNet)}</span>
                  </div>
                  {forecast.withoutSnapshot && (
                    <p className="text-xs text-muted-foreground">
                      ohne Kontostand-Referenz — Guthaben = Summe der Buchungen
                    </p>
                  )}
                </CardContent>
              </Card>
            )
          })()}

          {finished.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Beendet</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {finished.map((plan) => (
                  <PlanRowCard
                    key={plan.id}
                    plan={plan}
                    busyId={busyId}
                    onEdit={openEdit}
                    onToggleStatus={toggleStatus}
                    onDelete={setDeleting}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <PlanDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
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
