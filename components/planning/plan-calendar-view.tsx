"use client"

import * as React from "react"
import { PlanCalendar } from "@/components/planning/plan-calendar"
import { PlanDialog } from "@/components/planning/plan-dialog"
import {
  usePlans,
  type PlanOccurrence,
  type PlanRow,
} from "@/components/planning/api"
import { ErrorState } from "@/components/error-state"

/**
 * /calendar — the calendar used to be the left half of the /planung board.
 * It now owns its plan-edit dialog: a planned chip needs the full PlanRow,
 * which the calendar's occurrence payload does not carry, so the view keeps
 * the plan list loaded for chip clicks (the API still answers the full list
 * when called without paging params). A missing plan in that list means the
 * cache is stale (another tab mutated it) — refetch instead of leaving a
 * silently dead chip.
 */
export function PlanCalendarView() {
  const plansQuery = usePlans()
  const [editing, setEditing] = React.useState<PlanRow | null>(null)

  const handleEventClick = (occurrence: PlanOccurrence) => {
    const plan = plansQuery.data?.plans.find((p) => p.id === occurrence.planId)
    if (plan) {
      setEditing(plan)
    } else {
      void plansQuery.refetch()
    }
  }

  return (
    <div className="space-y-4">
      {plansQuery.isError && (
        <ErrorState onRetry={() => void plansQuery.refetch()} />
      )}
      <PlanCalendar accountId={null} onEventClick={handleEventClick} />

      {editing && (
        <PlanDialog
          open
          plan={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
        />
      )}
    </div>
  )
}
