"use client"

import { PlanCalendarView } from "@/components/planning/plan-calendar-view"

export default function CalendarPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Kalender
        </h1>
        <p className="text-sm text-muted-foreground">
          Kräftiger Termin = Plan · blass • = Buchung · ◌ = nicht gebucht · ✓ =
          geplant &amp; gebucht · rot = überfällig
        </p>
      </div>
      <PlanCalendarView />
    </div>
  )
}
