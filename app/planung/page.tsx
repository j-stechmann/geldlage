"use client"

import * as React from "react"
import { PlansBoard } from "@/components/planning/plans-board"

export default function PlanungPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Planung
        </h1>
        <p className="text-sm text-muted-foreground">
          Geplante Transaktionen — einmalig oder wiederkehrend — mit Abgleich
          gegen echte Buchungen und Guthaben-Prognose.
        </p>
      </div>
      <PlansBoard />
    </div>
  )
}
