"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { euro } from "@/lib/money"
import { apiFetch } from "@/lib/api-fetch"

export interface AnalyticsResponse {
  kpis: {
    currentBalanceCents: number | null
    balanceWithoutSnapshot: boolean
    avgMonthlyIncomeCents: number | null
    avgMonthlyExpensesCents: number | null
    savingsRate: number | null
    transactionCount: number
    monthsCounted: number
  }
  monthlyCashflow: Array<{
    month: string
    incomeCents: number
    expensesCents: number
    netCents: number
  }>
  balanceTimeline: Array<{ date: string; balanceCents: number }>
  topCategories: Array<{
    categoryId: number | null
    name: string
    color: string | null
    totalCents: number
    share: number
    txCount: number
  }>
  savingsHistory: {
    lastMonth: string
    lastMonthNetCents: number
    lastMonthIsStale: boolean
    months: Array<{
      month: string
      incomeCents: number
      expensesCents: number
      netCents: number
    }>
    currentMonth: {
      month: string
      incomeCents: number
      expensesCents: number
      netCents: number
    } | null
  } | null
}

export function useAnalytics(params: string) {
  return useQuery<AnalyticsResponse>({
    queryKey: ["analytics", params],
    queryFn: async () => {
      const res = await apiFetch(`/api/analytics?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    placeholderData: (prev) => prev,
  })
}

function KpiCard({
  title,
  value,
  sub,
  loading,
  warn,
}: {
  title: string
  value: string
  sub?: string
  loading: boolean
  warn?: boolean
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle
          className={`font-serif text-2xl tabular-nums ${warn ? "text-muted-foreground" : ""}`}
        >
          {loading ? <Skeleton className="h-8 w-28" /> : value}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  )
}

export function KpiRow({
  analytics,
  loading,
}: {
  analytics: AnalyticsResponse | undefined
  loading: boolean
}) {
  const k = analytics?.kpis
  const savingsRate =
    k?.savingsRate !== null && k?.savingsRate !== undefined
      ? `${Math.round(k.savingsRate * 100)} %`
      : "—"

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <KpiCard
        title="Aktueller Kontostand"
        value={euro(k?.currentBalanceCents)}
        loading={loading}
        warn={k?.balanceWithoutSnapshot}
        sub={
          k?.balanceWithoutSnapshot
            ? "ohne Kontostand-Referenz (Summe der Buchungen)"
            : undefined
        }
      />
      <KpiCard
        title="Ø Monatseinnahmen"
        value={euro(k?.avgMonthlyIncomeCents)}
        loading={loading}
        sub={k?.monthsCounted ? `über ${k.monthsCounted} Monate` : undefined}
      />
      <KpiCard
        title="Ø Monatsausgaben"
        value={euro(k?.avgMonthlyExpensesCents)}
        loading={loading}
        sub={
          k?.monthsCounted ? `über ${k.monthsCounted} volle Monate` : undefined
        }
      />
      <KpiCard
        title="Sparquote"
        value={savingsRate}
        loading={loading}
        sub={
          k?.savingsRate === null && k?.transactionCount
            ? "keine Einnahmen im Zeitraum"
            : undefined
        }
      />
      <KpiCard
        title="Transaktionen"
        value={loading ? "" : String(k?.transactionCount ?? 0)}
        loading={loading}
      />
    </div>
  )
}
