"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"

// ── DTOs (mirror the server contract in lib/planning/service.ts) ──────────

export interface PlanRow {
  id: string
  accountId: number | null
  accountName: string | null
  counterparty: string | null
  purpose: string | null
  amountCents: number
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  dtstart: string
  rrule: string | null
  status: "active" | "paused" | "finished"
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface PlanListRow extends PlanRow {
  nextDueDate: string | null
}

export interface PlanOccurrence {
  id: string
  planId: string
  date: string
  amountCents: number
  counterparty: string | null
  purpose: string | null
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  accountId: number | null
  planStatus: "active" | "paused"
  matched: {
    transactionId: string
    bookingDate: string
    amountCents: number
  } | null
}

export interface ForecastResult {
  startingBalanceCents: number
  withoutSnapshot: boolean
  today: string
  horizon: { from: string; to: string }
  monthlyPlanned: Array<{
    month: string
    incomeCents: number
    expensesCents: number
    netCents: number
  }>
  projectedBalance: Array<{ date: string; balanceCents: number }>
  plannedCategories: Array<{
    categoryId: number | null
    name: string
    color: string | null
    totalCents: number
    share: number
  }>
}

// ── query keys (house convention: two-phase, serializable params) ─────────

export const PLANS_KEY = ["plans"] as const

export function planOccurrencesKey(
  from: string,
  to: string,
  accountId: number | null
) {
  const sp = new URLSearchParams({ from, to })
  if (accountId !== null) sp.set("accountId", String(accountId))
  return ["plan-occurrences", sp.toString()] as const
}

export function calendarTransactionsKey(
  from: string,
  to: string,
  accountId: number | null
) {
  const sp = new URLSearchParams({ from, to })
  if (accountId !== null) sp.set("accountId", String(accountId))
  return ["transactions-calendar", sp.toString()] as const
}

export interface CalendarTransaction {
  id: string
  date: string
  /** verbatim DKB status: Gebucht | Nicht gebucht */
  status: "Gebucht" | "Nicht gebucht"
  counterparty: string | null
  purpose: string | null
  amountCents: number
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  accountId: number
}

export function forecastKey(months: number, accountId: number | null) {
  const sp = new URLSearchParams({ months: String(months) })
  if (accountId !== null) sp.set("accountId", String(accountId))
  return ["forecast", sp.toString()] as const
}

/** invalidation fan-out after any plan mutation */
export function invalidatePlans(
  queryClient: ReturnType<typeof useQueryClient>
) {
  void queryClient.invalidateQueries({ queryKey: PLANS_KEY })
  void queryClient.invalidateQueries({ queryKey: ["plan-occurrences"] })
  void queryClient.invalidateQueries({ queryKey: ["forecast"] })
  void queryClient.invalidateQueries({ queryKey: ["transactions-calendar"] })
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function parseError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as {
    error?: string
    message?: string
  } | null
  return new ApiError(
    res.status,
    data?.error ?? "error",
    data?.message ?? fallback
  )
}

// ── hooks ─────────────────────────────────────────────────────────────────

export function usePlans() {
  return useQuery<{ plans: PlanListRow[] }>({
    queryKey: PLANS_KEY,
    queryFn: async () => {
      const res = await apiFetch("/api/plans")
      if (!res.ok)
        throw await parseError(res, "Pläne konnten nicht geladen werden")
      return res.json()
    },
    placeholderData: (prev) => prev,
  })
}

export function usePlanOccurrences(
  from: string | null,
  to: string | null,
  accountId: number | null
) {
  const key =
    from && to
      ? planOccurrencesKey(from, to, accountId)
      : planOccurrencesKey("", "", null)
  return useQuery<{ occurrences: PlanOccurrence[] }>({
    queryKey: key,
    queryFn: async () => {
      const res = await apiFetch(`/api/plans/occurrences?${key[1]}`)
      if (!res.ok) {
        throw await parseError(res, "Termine konnten nicht geladen werden")
      }
      return res.json()
    },
    enabled: from !== null && to !== null,
    placeholderData: (prev) => prev,
  })
}

/** Booked real transactions of the same window — the calendar's "Buchungen". */
export function useCalendarTransactions(
  from: string | null,
  to: string | null,
  accountId: number | null
) {
  const key =
    from && to
      ? calendarTransactionsKey(from, to, accountId)
      : calendarTransactionsKey("", "", null)
  return useQuery<{ transactions: CalendarTransaction[] }>({
    queryKey: key,
    queryFn: async () => {
      const res = await apiFetch(`/api/transactions/calendar?${key[1]}`)
      if (!res.ok) {
        throw await parseError(res, "Buchungen konnten nicht geladen werden")
      }
      return res.json()
    },
    enabled: from !== null && to !== null,
    placeholderData: (prev) => prev,
  })
}

export function useForecast(
  enabled: boolean,
  months: number,
  accountId: number | null
) {
  const key = forecastKey(months, accountId)
  return useQuery<ForecastResult>({
    queryKey: key,
    queryFn: async () => {
      const sp = new URLSearchParams({ months: String(months) })
      if (accountId !== null) sp.set("accountId", String(accountId))
      const res = await apiFetch(`/api/plans/forecast?${sp.toString()}`)
      if (!res.ok) {
        throw await parseError(res, "Prognose konnte nicht geladen werden")
      }
      return (await res.json()).forecast as ForecastResult
    },
    enabled,
    placeholderData: (prev) => prev,
  })
}

/**
 * Deep link to the transactions table showing exactly this bank
 * transaction: `?tx=<id>` — the table then queries the single row by id
 * (user-scoped), independent of any filter state, and expands + highlights
 * it. Any filter edit drops the param back to normal browsing.
 */
export function transactionDeepLink(tx: CalendarTransaction): string {
  return `/transactions?tx=${encodeURIComponent(tx.id)}`
}

// ── mutations (plain fetch + toast per outcome, house pattern) ────────────

export interface PlanFormValues {
  accountId: number | null
  counterparty: string | null
  purpose: string | null
  amountCents: number
  categoryId: number | null
  dtstart: string
  rrule: string | null
  notes: string | null
  status?: "active" | "paused" | "finished"
}

export async function createPlan(values: PlanFormValues): Promise<void> {
  const res = await apiFetch("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  })
  if (!res.ok) {
    throw await parseError(res, "Plan konnte nicht erstellt werden")
  }
  await res.json()
}

export async function updatePlan(
  id: string,
  values: Partial<PlanFormValues>
): Promise<void> {
  const res = await apiFetch(`/api/plans/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  })
  if (!res.ok) {
    throw await parseError(res, "Plan konnte nicht gespeichert werden")
  }
}

export async function deletePlan(id: string): Promise<void> {
  const res = await apiFetch(`/api/plans/${id}`, { method: "DELETE" })
  if (!res.ok) {
    throw await parseError(res, "Plan konnte nicht gelöscht werden")
  }
}

export async function setPlanStatus(
  id: string,
  status: "active" | "paused" | "finished"
): Promise<void> {
  await updatePlan(id, { status })
}

// ── German helpers ────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, string> = {
  MO: "Mo",
  TU: "Di",
  WE: "Mi",
  TH: "Do",
  FR: "Fr",
  SA: "Sa",
  SU: "So",
}

const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
]

/**
 * Humanize a bare RFC 5545 RRULE (allowlisted subset) into short German
 * text — the plan list's "Wiederholung" column. Unmapped shapes fall back
 * to the raw string.
 */
export function describeRrule(rruleText: string | null): string {
  if (rruleText === null || rruleText.trim() === "") return "einmalig"
  const parts = new Map(
    rruleText
      .trim()
      .toUpperCase()
      .replace(/^RRULE:/, "")
      .split(";")
      .filter(Boolean)
      .map((pair) => pair.split("=") as [string, string])
  )
  const freq = parts.get("FREQ")
  const interval = Number.parseInt(parts.get("INTERVAL") ?? "1", 10)
  if (!freq) return rruleText
  let base: string
  if (freq === "DAILY") {
    base = interval === 1 ? "täglich" : `alle ${interval} Tage`
  } else if (freq === "WEEKLY") {
    const byDay = describeByWeekday(parts.get("BYDAY"))
    base = `${interval === 1 ? "wöchentlich" : `alle ${interval} Wochen`}${byDay}`
  } else if (freq === "MONTHLY") {
    const byDay = parts.get("BYDAY")
    const byMonthDay = parts.get("BYMONTHDAY")
    // ordinal BYDAY of any width — validation accepts every RFC ordinal
    // (e.g. 5FR), so the badge must describe it, not degrade to a bare
    // "monatlich"
    if (byDay && /^(-?\d+)(MO|TU|WE|TH|FR|SA|SU)(,.+)*$/.exec(byDay.trim())) {
      const ordinals = describeByWeekday(byDay)
      base = `${interval === 1 ? "am" : `alle ${interval} Monate am`} ${ordinals}`
    } else if (byMonthDay) {
      base = `${interval === 1 ? "am" : `alle ${interval} Monate am`} ${ordinalizeMonthDays(byMonthDay)}`
    } else {
      base = interval === 1 ? "monatlich" : `alle ${interval} Monate`
    }
  } else if (freq === "YEARLY") {
    const byMonthRaw = parts.get("BYMONTH")
    const byMonthDay = parts.get("BYMONTHDAY")
    const byDayRaw = parts.get("BYDAY")
    // interval is part of the cadence ("alle 2 Jahre"), never a bare "jährlich"
    const years = interval === 1 ? "jährlich" : `alle ${interval} Jahre`
    const byDayTokens = (byDayRaw ?? "").split(",").filter(Boolean)
    const allOrdinalByDay =
      byDayTokens.length > 0 &&
      byDayTokens.every((t) => /^(-?\d+)(MO|TU|WE|TH|FR|SA|SU)$/.test(t))
    // BYDAY + BYMONTHDAY intersect per RFC 5545 — no compact truthful text:
    // keep the full raw rule (same escape hatch as BYSETPOS)
    if (byDayRaw !== undefined && byMonthDay !== undefined) return rruleText
    if (byMonthRaw === undefined && byMonthDay !== undefined) {
      // yearless BYMONTHDAY repeats the day in EVERY month (12×/year —
      // engine-verified; the dialog warns at creation): the badge must say
      // so instead of a lying "jährlich am 15."
      base =
        interval === 1
          ? `am ${ordinalizeMonthDays(byMonthDay)} jedes Monats`
          : `am ${ordinalizeMonthDays(byMonthDay)} jedes Monats (alle ${interval} Jahre)`
    } else if (
      byMonthRaw === undefined &&
      byDayRaw !== undefined &&
      !allOrdinalByDay
    ) {
      // yearless plain BYDAY repeats that weekday all year (~52×/year)
      const weekdays = describeByWeekday(byDayRaw)
      base =
        interval === 1
          ? `jeden ${weekdays}`
          : `jeden ${weekdays} (alle ${interval} Jahre)`
    } else {
      // genuinely annual: any BYMONTH, or a yearless ordinal BYDAY
      // ("1MO" counts across the whole year → once per interval-year)
      const byMonth = describeByMonth(byMonthRaw)
      base = `${years}${byMonth ? ` in ${byMonth}` : ""}${byMonthDay ? ` am ${ordinalizeMonthDays(byMonthDay)}` : byDayRaw ? ` am ${describeByWeekday(byDayRaw)}` : ""}`
    }
  } else {
    return rruleText
  }
  if (parts.get("COUNT")) return `${base}, ${parts.get("COUNT")}×`
  const until = describeUntil(parts.get("UNTIL"))
  if (until) return `${base}, bis ${until}`
  if (parts.get("BYSETPOS")) return rruleText
  return base
}

/** "MO,TU" → "Mo/Di" · "2TU" → "2. Di" · "-1FR" → "letzten Fr" */
function describeByWeekday(byDay: string | undefined): string {
  if (!byDay) return ""
  const tokens = byDay.split(",").filter(Boolean)
  return tokens
    .map((t) => {
      const m = /^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(t)
      if (!m) return ""
      const name = WEEKDAYS[m[2]] ?? m[2]
      if (m[1] === undefined) return name
      const n = Number.parseInt(m[1], 10)
      return n === -1 ? `letzten ${name}` : `${n}. ${name}`
    })
    .filter(Boolean)
    .join("/")
}

/** "1,15,-1" → "1./15./letzten Tag" */
function ordinalizeMonthDays(byMonthDay: string): string {
  return byMonthDay
    .split(",")
    .filter(Boolean)
    .map((v) => {
      const n = Number.parseInt(v, 10)
      if (!Number.isInteger(n)) return ""
      if (n === -1) return "letzten Tag"
      if (n < 0) return `${-n}. Tag von hinten`
      return `${n}.`
    })
    .filter(Boolean)
    .join("/")
}

function describeByMonth(byMonth: string | undefined): string {
  if (!byMonth) return ""
  return byMonth
    .split(",")
    .filter(Boolean)
    .map((m) => MONTHS[Number.parseInt(m, 10) - 1])
    .filter(Boolean)
    .join("/")
}

/** "20300315T120000Z" → "15.03.2030" */
function describeUntil(until: string | undefined): string | null {
  if (!until) return null
  const m = /^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/.exec(until.trim())
  if (!m) return null
  return `${m[3]}.${m[2]}.${m[1]}`
}

/** German day label for ISO date: "03.11.2026" */
export function germanDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}
