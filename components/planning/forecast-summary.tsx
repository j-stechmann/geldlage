"use client"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { germanDate, type ForecastResult } from "@/components/planning/api"
import { euro } from "@/lib/money"

/**
 * The 12-month projection summary. It lives on the dashboard (behind the
 * "Geplant einblenden" toggle) rather than on /plans: the figures are the
 * same snapshot-anchored forecast the dashboard charts overlay, and /plans
 * itself is a CRUD list whose money belongs to individual plans.
 */
export function ForecastSummary({ forecast }: { forecast: ForecastResult }) {
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
          ab heutigem Guthaben, ohne geplante Beträge, die bereits gebucht sind;
          pausierte Pläne zählen nicht mit
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">Guthaben heute</span>
          <span className="tabular-nums">
            {euro(forecast.startingBalanceCents)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">
            Projektion zum {germanDate(forecast.horizon.to)}
          </span>
          <span className="font-medium tabular-nums">{euro(projected)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
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
}
