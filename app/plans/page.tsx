"use client"

import { PlansList } from "@/components/planning/plans-list"

export default function PlansPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Planung
        </h1>
        <p className="text-sm text-muted-foreground">
          Geplante Transaktionen — einmalig oder wiederkehrend. Suche, filtere
          und bearbeite Pläne; der Abgleich mit echten Buchungen läuft über den
          Kalender. Pausierte Pläne bleiben sichtbar, zählen aber nicht in der
          Prognose.
        </p>
      </div>
      <PlansList />
    </div>
  )
}
