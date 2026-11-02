"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { PlanCalendar } from "@/components/planning/plan-calendar"
import { PlanDialog } from "@/components/planning/plan-dialog"
import {
  usePlans,
  type PlanOccurrence,
  type PlanRow,
} from "@/components/planning/api"
import { ErrorState } from "@/components/error-state"
import { Button } from "@/components/ui/button"

/**
 * /calendar — the calendar used to be the left half of the /planung board.
 * It now owns its plan dialog: a planned chip needs the full PlanRow, which
 * the calendar's occurrence payload does not carry, so the view keeps the
 * plan list loaded for chip clicks (the API still answers the full list when
 * called without paging params, skipping the per-plan next-date walk with
 * `includeNextDue=0`). A missing plan in that list means the cache is stale
 * (another tab mutated it) — refetch instead of leaving a silently dead chip.
 *
 * "Plan anlegen" stays here (the old board had it beside the calendar):
 * /plans is the list view, but starting a plan from the calendar should not
 * require a detour through it.
 */
export function PlanCalendarView() {
  const plansQuery = usePlans()
  // Read `data` during render: React Query v5 tracks which result properties a
  // render touches and only notifies on those. A handler-only read would leave
  // the first chip click after the list loads on the mount-time result
  // (`data: undefined`) — it would silently refetch instead of opening the
  // dialog until something else re-rendered the view.
  const plans = plansQuery.data?.plans ?? []
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<PlanRow | null>(null)

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const handleEventClick = (occurrence: PlanOccurrence) => {
    const plan = plans.find((p) => p.id === occurrence.planId)
    if (plan) {
      setEditing(plan)
      setDialogOpen(true)
    } else {
      void plansQuery.refetch()
    }
  }

  return (
    <div className="space-y-4">
      {plansQuery.isError && (
        <ErrorState onRetry={() => void plansQuery.refetch()} />
      )}
      <div className="flex items-center justify-end">
        <Button onClick={openCreate} size="sm">
          <Plus data-icon="inline-start" />
          Plan anlegen
        </Button>
      </div>
      <PlanCalendar accountId={null} onEventClick={handleEventClick} />

      <PlanDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        plan={editing}
      />
    </div>
  )
}
