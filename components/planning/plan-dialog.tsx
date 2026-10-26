"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { RRule, rrulestr } from "rrule"
import { normalizeRuleInput } from "@/lib/planning/recurrence"
import { todayLocal } from "@/lib/analytics/date"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { parseGermanAmountToCents, formatCentsAsGerman } from "@/lib/money"
import { apiFetch } from "@/lib/api-fetch"
import {
  createPlan,
  updatePlan,
  ApiError,
  type PlanFormValues,
  type PlanRow,
} from "@/components/planning/api"
import {
  expandOccurrenceDates,
  isValidIsoDate,
  isoDatePlus,
  noonUtc,
} from "@/lib/planning/recurrence"

interface AccountOption {
  id: number
  iban: string
  name: string
}
interface LabelOption {
  id: number
  name: string
  origin: string
  color: string | null
}

interface FormState {
  direction: "Ausgang" | "Eingang"
  amountText: string
  counterparty: string
  purpose: string
  notes: string
  accountId: string // "all" = any account
  categoryId: string // "none" = no category
  dtstart: string
  /** "" = einmalig */
  freq: "" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  interval: number
  byDay: string[]
  monthlyMode: "mday" | "wday"
  byMonthDayText: string
  ordinal: string
  ordinalDay: string
  byMonth: string[]
  yearlyMode: "mday" | "wday"
  yearlyMonthDayText: string
  endMode: "none" | "until" | "count"
  untilDate: string
  count: number
  /** the effective RRULE text (builder writes it; user edits make it raw) */
  rawRrule: string
  rawDirty: boolean
}

const EMPTY_FORM: FormState = {
  direction: "Ausgang",
  amountText: "",
  counterparty: "",
  purpose: "",
  notes: "",
  accountId: "all",
  categoryId: "none",
  dtstart: "",
  freq: "",
  interval: 1,
  byDay: [],
  monthlyMode: "mday",
  byMonthDayText: "",
  ordinal: "1",
  ordinalDay: "MO",
  byMonth: [],
  yearlyMode: "mday",
  yearlyMonthDayText: "",
  endMode: "none",
  untilDate: "",
  count: 12,
  rawRrule: "",
  rawDirty: false,
}

const WEEKDAY_CHIPS: Array<{ value: string; label: string }> = [
  { value: "MO", label: "Mo" },
  { value: "TU", label: "Di" },
  { value: "WE", label: "Mi" },
  { value: "TH", label: "Do" },
  { value: "FR", label: "Fr" },
  { value: "SA", label: "Sa" },
  { value: "SU", label: "So" },
]

const MONTH_CHIPS = [
  "Jan",
  "Feb",
  "Mär",
  "Apr",
  "Mai",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Okt",
  "Nov",
  "Dez",
]

function field(label: string, children: React.ReactNode, hint?: string) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  )
}

/** Parse a comma list of month days ("1,15,-1"); throws on garbage. */
function parseByMonthDay(text: string): number[] {
  const list = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (list.length === 0) return []
  const nums = list.map((s) => Number.parseInt(s, 10))
  if (
    nums.some((n) => !Number.isInteger(n) || n === 0 || Math.abs(n) > 31) ||
    new Set(nums).size !== nums.length ||
    list.length > 31
  ) {
    throw new Error("Ungültige Monatstage")
  }
  return nums
}

/** Compose the RRULE text from the builder fields; null = one-off. */
function buildRrule(s: FormState): string | null {
  if (s.freq === "") return null
  const parts: string[] = [`FREQ=${s.freq}`]
  if (s.interval > 1) parts.push(`INTERVAL=${s.interval}`)
  if (s.freq === "WEEKLY" && s.byDay.length > 0) {
    parts.push(`BYDAY=${s.byDay.join(",")}`)
  }
  if (s.freq === "MONTHLY") {
    if (s.monthlyMode === "wday") {
      parts.push(`BYDAY=${s.ordinal}${s.ordinalDay}`)
    } else {
      const days = parseByMonthDay(s.byMonthDayText)
      if (days.length > 0) parts.push(`BYMONTHDAY=${days.join(",")}`)
    }
  }
  if (s.freq === "YEARLY") {
    if (s.byMonth.length > 0) parts.push(`BYMONTH=${s.byMonth.join(",")}`)
    if (s.yearlyMode === "wday") {
      parts.push(`BYDAY=${s.ordinal}${s.ordinalDay}`)
    } else {
      const days = parseByMonthDay(s.yearlyMonthDayText)
      if (days.length > 0) parts.push(`BYMONTHDAY=${days.join(",")}`)
    }
  }
  if (s.endMode === "until") {
    if (s.untilDate && isValidIsoDate(s.untilDate)) {
      // noon-anchored UNTIL → the chosen day stays INCLUDED (occurrences sit
      // at noon on the same UTC clock)
      const u = noonUtc(s.untilDate)
      const pad = (n: number) => String(n).padStart(2, "0")
      parts.push(
        `UNTIL=${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}T${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}${pad(u.getUTCSeconds())}Z`
      )
    }
  } else if (s.endMode === "count") {
    const n = Math.round(s.count)
    if (Number.isInteger(n) && n >= 1 && n <= 366) parts.push(`COUNT=${n}`)
  }
  return parts.join(";")
}

/** Ascending-ISO equality of two occurrence expansions. */
function sameOccurrenceSets(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i])
}

/**
 * Map a stored RRULE back into the builder fields; returns the overrides to
 * apply. The result is gated on faithfulness: whenever the builder fields
 * (EMPTY_FORM + overrides) cannot reproduce the stored rule's occurrences
 * 1:1, `rawDirty=true` and the raw text stays authoritative — an untouched
 * edit-save must never silently rewrite a recurrence the builder can't
 * represent (2+ month-chips with a weekday pattern, multi-ordinal BYDAY,
 * weekday-yearly without BYMONTH, BYDAY+BYMONTHDAY mixes, WKST variants).
 * Exported for the dialog round-trip regression tests.
 */
export function parseRruleToForm(
  rruleText: string | null,
  dtstart?: string | null
): Partial<FormState> {
  if (rruleText === null || rruleText.trim() === "") {
    return { freq: "", rawRrule: "", rawDirty: false }
  }
  try {
    const parsed = rrulestr(normalizeRuleInput(rruleText), {
      forceset: false,
    })
    if (!(parsed instanceof RRule))
      return { rawRrule: rruleText, rawDirty: true }
    const o = parsed.origOptions as {
      freq?: number
      interval?: number
      count?: number
      until?: Date | number | null
      byweekday?: unknown
      bymonthday?: number | number[]
      bymonth?: number | number[]
      bysetpos?: unknown
    }
    // freq: YEARLY=0, MONTHLY=1, WEEKLY=2, DAILY=3
    const freq =
      o.freq === 3
        ? "DAILY"
        : o.freq === 2
          ? "WEEKLY"
          : o.freq === 1
            ? "MONTHLY"
            : o.freq === 0
              ? "YEARLY"
              : null
    if (freq === null || o.bysetpos !== undefined) {
      return { rawRrule: rruleText, rawDirty: true }
    }
    const overrides: Partial<FormState> = {
      freq,
      interval: typeof o.interval === "number" ? o.interval : 1,
    }
    const count = typeof o.count === "number" ? o.count : null
    const until = o.until instanceof Date ? o.until : null
    if (count !== null) {
      overrides.endMode = "count"
      overrides.count = count
    } else if (until !== null) {
      overrides.endMode = "until"
      overrides.untilDate = until.toISOString().slice(0, 10)
    } else {
      overrides.endMode = "none"
    }

    const collect = (v: unknown): unknown[] =>
      Array.isArray(v) ? v : v !== undefined ? [v] : []
    const LETTERS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    const byDayTokens = collect(o.byweekday)
      .map((wd): string => {
        const weekday: number =
          typeof wd === "number"
            ? wd
            : ((wd as { weekday?: number }).weekday ?? -1)
        // rrule's Weekday carries the ordinal as `n` ("1FR" → {weekday:4,n:1});
        // plain tokens have no n — reading `.nth` would never resolve
        const nth: number | undefined =
          typeof wd === "object" && wd !== null
            ? ((wd as { n?: number }).n ?? undefined)
            : undefined
        const letter = LETTERS[weekday]
        if (!letter) return ""
        return nth !== undefined ? `${nth}${letter}` : letter
      })
      .filter(Boolean)

    if (freq === "WEEKLY") {
      // ordinal BYDAY tokens are not valid for weekly rules (validation
      // rejects them) — filtered defensively anyway, signed forms included
      overrides.byDay = byDayTokens.filter((t) => !/^-?\d/.test(t))
    }
    if (freq === "MONTHLY" || freq === "YEARLY") {
      // signed tokens too: "1FR,-1FR" is two ordinals, not one + a plain day
      const ordinals = byDayTokens.filter((t) => /^-?\d/.test(t))
      const monthDays = (collect(o.bymonthday) as (number | string)[])
        .map((n) => Number.parseInt(String(n), 10))
        .filter((n) => Number.isInteger(n))
      const months = (collect(o.bymonth) as (number | string)[])
        .map((n) => Number.parseInt(String(n), 10))
        .filter((n) => Number.isInteger(n))
      const ordinal = ordinals.length === 1 ? ordinals[0] : null
      if (
        ordinal !== null &&
        (freq === "MONTHLY"
          ? monthDays.length === 0
          : months.length === 1 && monthDays.length === 0)
      ) {
        const parts = /^(-?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(ordinal)
        if (parts) {
          if (freq === "MONTHLY") {
            overrides.monthlyMode = "wday"
            overrides.ordinal = parts[1]
            overrides.ordinalDay = parts[2]
          } else {
            overrides.yearlyMode = "wday"
            overrides.byMonth = months.map(String)
            overrides.ordinal = parts[1]
            overrides.ordinalDay = parts[2]
          }
        }
      } else {
        overrides.monthlyMode = "mday"
        overrides.byMonthDayText = monthDays.join(",")
        if (freq === "YEARLY") {
          overrides.yearlyMode = "mday"
          overrides.yearlyMonthDayText = monthDays.join(",")
          overrides.byMonth = months.map(String)
        }
      }
    }
    overrides.rawRrule = rruleText
    // Faithfulness gate: rebuild the rule exactly as the dialog's effective
    // rule would be on an untouched open ({EMPTY_FORM + overrides}) and
    // require it to produce the SAME occurrences as the stored rule over an
    // 800-day window (two annual cycles — catches year-level aliasing like
    // "1MO yearly" vs a plain yearly whose first year coincides). Equal sets
    // → the builder can own the rule; otherwise the raw text stays
    // authoritative. A string comparison would be wrong here: canonical
    // spellings differ (e.g. an explicit INTERVAL=1) while the semantics
    // agree.
    let faithful = false
    if (dtstart != null && isValidIsoDate(dtstart)) {
      const w = { from: dtstart, to: isoDatePlus(dtstart, 800) }
      let rebuilt: string | null = null
      try {
        rebuilt = buildRrule({ ...EMPTY_FORM, ...overrides })
      } catch {
        rebuilt = null
      }
      faithful =
        rebuilt !== null &&
        sameOccurrenceSets(
          expandOccurrenceDates(dtstart, rruleText, w),
          expandOccurrenceDates(dtstart, rebuilt, w)
        )
    }
    overrides.rawDirty = !faithful
    return overrides
  } catch {
    return { rawRrule: rruleText, rawDirty: true }
  }
}

/** Build the fully-initialized form for a dialog open (edit plan or new). */
function initialForm(plan: PlanRow | null | undefined): FormState {
  if (plan) {
    const overrides = parseRruleToForm(plan.rrule, plan.dtstart)
    return {
      ...EMPTY_FORM,
      direction: plan.amountCents > 0 ? "Eingang" : "Ausgang",
      amountText: formatCentsAsGerman(Math.abs(plan.amountCents)),
      counterparty: plan.counterparty ?? "",
      purpose: plan.purpose ?? "",
      notes: plan.notes ?? "",
      accountId: plan.accountId === null ? "all" : String(plan.accountId),
      categoryId: plan.categoryId === null ? "none" : String(plan.categoryId),
      dtstart: plan.dtstart,
      ...overrides,
    }
  }
  return { ...EMPTY_FORM, dtstart: todayLocal() }
}

function describePlanError(err: unknown): string {
  const fallback =
    err instanceof Error && err.message ? err.message : "Netzwerkfehler"
  if (!(err instanceof ApiError)) return fallback
  const map: Record<string, string> = {
    invalid_amount:
      "Betrag ist ungültig (nicht-null Ganzzahl in Cent erwartet)",
    invalid_dtstart:
      "Startdatum ist kein gültiges Datum (frühestens 01.01.1900)",
    invalid_rrule: "Wiederholungsregel ist ungültig",
    invalid_status: "Status ist ungültig",
    invalid_counterparty: "Vertragspartner ist zu lang (max. 128 Bytes)",
    invalid_purpose: "Verwendungszweck ist zu lang (max. 500 Bytes)",
    invalid_notes: "Notizen sind zu lang (max. 500 Bytes)",
    account_not_found: "Konto nicht gefunden",
    category_not_found: "Kategorie nicht gefunden",
    invalid_plan: "Betrag und Startdatum sind erforderlich",
  }
  return map[err.code] ?? fallback
}

export interface PlanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** set = edit existing plan; null/undefined = create */
  plan?: PlanRow | null
}

export function PlanDialog({
  open,
  onOpenChange,
  plan,
}: PlanDialogProps) {
  const isEdit = plan !== null && plan !== undefined
  const [busy, setBusy] = React.useState(false)

  // initial state is derived per dialog open (plan/new); adjusting state
  // during render ("adjusting state when a prop change", react.dev) avoids
  // an effect entirely
  const initKey = `${open ? "open" : "closed"}|${plan?.id ?? "new"}`
  const [form, setForm] = React.useState<FormState>(() => initialForm(plan))
  const [renderedKey, setRenderedKey] = React.useState(initKey)
  if (renderedKey !== initKey) {
    setRenderedKey(initKey)
    setForm(initialForm(plan))
  }

  const set = React.useCallback(
    (patch: Partial<FormState>) => setForm((prev) => ({ ...prev, ...patch })),
    []
  )

  const { data: accounts } = useQuery<AccountOption[]>({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await apiFetch("/api/accounts")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { accounts: AccountOption[] }
      return data.accounts
    },
    enabled: open,
  })
  const { data: labelsData } = useQuery<{ labels: LabelOption[] }>({
    queryKey: ["labels"],
    queryFn: async () => {
      const res = await apiFetch("/api/labels")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    enabled: open,
  })

  // the effective RRULE text: builder output, unless the user edits raw —
  // plus a rule-error flag. buildRrule can throw (parseByMonthDay on
  // garbage/duplicate month days); the memo must never: an uncaught render
  // error here would unmount the whole app (no error.tsx boundary exists).
  // The flag turns the throw into inline preview text + a disabled save.
  const effective = React.useMemo<{
    rrule: string | null
    error: string | null
  }>(() => {
    if (form.rawDirty) {
      return {
        rrule: form.rawRrule.trim() === "" ? null : form.rawRrule.trim(),
        error: null,
      }
    }
    try {
      return { rrule: buildRrule(form), error: null }
    } catch (err) {
      return {
        rrule: null,
        error:
          err instanceof Error && err.message
            ? err.message
            : "Ungültige Wiederholungsregel",
      }
    }
  }, [form])
  const effectiveRrule = effective.rrule

  // ── preview: next ≤3 dates, from the effective rule (same engine as the
  // server: the rrule package) ──
  const preview = React.useMemo(() => {
    if (effective.error !== null) {
      return { dates: [] as string[], error: effective.error }
    }
    const dtstart = form.dtstart
    if (!isValidIsoDate(dtstart))
      return { dates: [] as string[], error: null as string | null }
    if (effective.rrule === null) return { dates: [dtstart], error: null }
    try {
      const parsed = rrulestr(normalizeRuleInput(effective.rrule), {
        forceset: false,
      })
      if (!(parsed instanceof RRule))
        return { dates: [], error: "Regel nicht unterstützt" }
      // explicit dtstart — parse-only rules default dtstart to "now" and
      // would return nothing for windows before today
      const rule = new RRule({
        ...parsed.origOptions,
        dtstart: noonUtc(dtstart),
      } as never)
      const dates = rule
        .between(noonUtc(dtstart), noonUtc(isoDatePlus(dtstart, 400)), true)
        .slice(0, 3)
        .map((d) => d.toISOString().slice(0, 10))
      if (dates.length === 0) {
        return {
          dates,
          error:
            "Diese Regel erzeugt keinen Termin am oder nach dem Startdatum",
        }
      }
      return { dates, error: null }
    } catch {
      return { dates: [], error: "Wiederholungsregel ist ungültig" }
    }
  }, [effective, form.dtstart])

  // short-month hint: monthly rules on days ≥ 29 skip short months
  const monthDayHint = React.useMemo(() => {
    if (form.freq !== "MONTHLY" || form.monthlyMode !== "mday") return null
    const days = form.byMonthDayText
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 29)
    if (days.length === 0) return null
    return days.length === 1
      ? `In kurzen Monaten (z. B. Februar) springt diese Regel über den ${days[0]}. — der Termin fällt aus.`
      : "In kurzen Monaten (z. B. Februar) springt diese Regel über die gewählten Tage — die Termine fallen aus."
  }, [form.freq, form.monthlyMode, form.byMonthDayText])

  const save = async () => {
    // defense in depth: the button is already disabled on a rule error —
    // saving would otherwise send rrule: null and silently strip a
    // recurrence the failed builder simply couldn't render
    if (effective.error !== null) return
    setBusy(true)
    try {
      const amountText = form.amountText.trim()
      const cents = parseGermanAmountToCents(amountText)
      const amountCents = form.direction === "Eingang" ? cents : -cents
      const values: PlanFormValues = {
        accountId:
          form.accountId === "all" ? null : Number.parseInt(form.accountId, 10),
        counterparty:
          form.counterparty.trim() === "" ? null : form.counterparty.trim(),
        purpose: form.purpose.trim() === "" ? null : form.purpose.trim(),
        amountCents,
        categoryId:
          form.categoryId === "none"
            ? null
            : Number.parseInt(form.categoryId, 10),
        dtstart: form.dtstart,
        rrule: effectiveRrule,
        notes: form.notes.trim() === "" ? null : form.notes.trim(),
      }
      if (isEdit && plan) {
        await updatePlan(plan.id, values)
      } else {
        await createPlan(values)
      }
      toast.success(isEdit ? "Plan aktualisiert" : "Plan erstellt")
      onOpenChange(false)
    } catch (err) {
      if (
        err instanceof RangeError ||
        (err instanceof Error && err.name === "ParseError")
      ) {
        toast.error("Betrag ist ungültig", {
          description: 'Eingabe wie "1.234,56" erwartet.',
        })
      } else {
        toast.error(
          isEdit ? "Speichern fehlgeschlagen" : "Erstellen fehlgeschlagen",
          {
            description: describePlanError(err),
          }
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const canSave =
    isValidIsoDate(form.dtstart) &&
    form.amountText.trim() !== "" &&
    effective.error === null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Plan bearbeiten" : "Geplante Transaktion anlegen"}
          </DialogTitle>
          <DialogDescription>
            Pläne sind virtuell — sie erscheinen im Kalender und in der
            Prognose, berühren aber echte Buchungen nicht.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            {field(
              "Richtung",
              <Select
                value={form.direction}
                onValueChange={(v) =>
                  set({ direction: (v ?? "Ausgang") as "Ausgang" | "Eingang" })
                }
                items={{ Ausgang: "Ausgabe (−)", Eingang: "Einnahme (+)" }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Ausgang">Ausgabe (−)</SelectItem>
                  <SelectItem value="Eingang">Einnahme (+)</SelectItem>
                </SelectContent>
              </Select>
            )}
            {field(
              "Betrag",
              <Input
                inputMode="decimal"
                placeholder="1.234,56"
                value={form.amountText}
                onChange={(e) => set({ amountText: e.target.value })}
                aria-label="Betrag"
              />,
              "Deutsches Format, z. B. 950,00"
            )}
            {field(
              "Startdatum",
              <Input
                type="date"
                value={form.dtstart}
                onChange={(e) => set({ dtstart: e.target.value })}
                aria-label="Startdatum"
              />
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {field(
              "Vertragspartner",
              <Input
                value={form.counterparty}
                onChange={(e) => set({ counterparty: e.target.value })}
                placeholder="z. B. Mietwerk GmbH"
                maxLength={128}
                aria-label="Vertragspartner"
              />,
              "Pflanzt ein Gegenpartei-Match für die „gebucht“-Erkennung — der Text muss (Groß-/Kleinschreibung egal) im Vertragspartner der Buchungen vorkommen."
            )}
            {field(
              "Verwendungszweck",
              <Input
                value={form.purpose}
                onChange={(e) => set({ purpose: e.target.value })}
                aria-label="Verwendungszweck"
              />
            )}
            {field(
              "Notizen",
              <Input
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
                aria-label="Notizen"
              />
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {field(
              "Konto",
              <Select
                value={form.accountId}
                onValueChange={(v) => set({ accountId: v ?? "all" })}
                items={{
                  all: "Alle Konten",
                  ...Object.fromEntries(
                    (accounts ?? []).map((a) => [String(a.id), a.name])
                  ),
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Alle Konten" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Konten</SelectItem>
                  {(accounts ?? []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {field(
              "Kategorie",
              <Select
                value={form.categoryId}
                onValueChange={(v) => set({ categoryId: v ?? "none" })}
                items={{
                  none: "ohne Kategorie",
                  ...Object.fromEntries(
                    (labelsData?.labels ?? []).map((l) => [
                      String(l.id),
                      l.name,
                    ])
                  ),
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="ohne Kategorie" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">ohne Kategorie</SelectItem>
                  {(labelsData?.labels ?? []).map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              {field(
                "Wiederholung",
                <Select
                  value={form.freq === "" ? "once" : form.freq}
                  onValueChange={(v) =>
                    set({
                      freq:
                        v === null || v === "once"
                          ? ""
                          : (v as FormState["freq"]),
                      rawDirty: false,
                    })
                  }
                  items={{
                    once: "Einmalig",
                    DAILY: "Täglich",
                    WEEKLY: "Wöchentlich",
                    MONTHLY: "Monatlich",
                    YEARLY: "Jährlich",
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="once">Einmalig</SelectItem>
                    <SelectItem value="DAILY">Täglich</SelectItem>
                    <SelectItem value="WEEKLY">Wöchentlich</SelectItem>
                    <SelectItem value="MONTHLY">Monatlich</SelectItem>
                    <SelectItem value="YEARLY">Jährlich</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {form.freq !== "" &&
                field(
                  "Alle",
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={form.interval}
                    onChange={(e) =>
                      set({
                        interval: Math.max(
                          1,
                          Math.round(Number(e.target.value) || 1)
                        ),
                      })
                    }
                    aria-label="Intervall"
                  />,
                  form.freq === "WEEKLY"
                    ? "Wochen zwischen den Terminen"
                    : form.freq === "MONTHLY"
                      ? "Monate zwischen den Terminen"
                      : "Tage/Jahre zwischen den Terminen"
                )}
              {form.freq !== "" &&
                field(
                  "Ende",
                  <Select
                    value={form.endMode}
                    onValueChange={(v) =>
                      set({ endMode: (v ?? "none") as FormState["endMode"] })
                    }
                    items={{
                      none: "Nie",
                      until: "Am Datum",
                      count: "Nach N Vorfällen",
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Nie</SelectItem>
                      <SelectItem value="until">Am Datum</SelectItem>
                      <SelectItem value="count">Nach N Vorfällen</SelectItem>
                    </SelectContent>
                  </Select>
                )}
            </div>

            {form.endMode === "until" && (
              <div className="max-w-60">
                {field(
                  "Enddatum",
                  <Input
                    type="date"
                    value={form.untilDate}
                    onChange={(e) => set({ untilDate: e.target.value })}
                    aria-label="Enddatum"
                  />
                )}
              </div>
            )}
            {form.endMode === "count" && (
              <div className="max-w-40">
                {field(
                  "Anzahl",
                  <Input
                    type="number"
                    min={1}
                    max={366}
                    value={form.count}
                    onChange={(e) =>
                      set({ count: Math.round(Number(e.target.value) || 1) })
                    }
                    aria-label="Anzahl Vorfälle"
                  />,
                  `${form.count} Termine`
                )}
              </div>
            )}

            {form.freq === "WEEKLY" && (
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_CHIPS.map((chip) => (
                  <Button
                    key={chip.value}
                    type="button"
                    size="sm"
                    variant={
                      form.byDay.includes(chip.value) ? "default" : "outline"
                    }
                    aria-pressed={form.byDay.includes(chip.value)}
                    onClick={() =>
                      set({
                        byDay: form.byDay.includes(chip.value)
                          ? form.byDay.filter((d) => d !== chip.value)
                          : [...form.byDay, chip.value],
                      })
                    }
                  >
                    {chip.label}
                  </Button>
                ))}
              </div>
            )}

            {form.freq === "MONTHLY" && (
              <div className="grid gap-3 sm:grid-cols-2">
                {field(
                  "Muster",
                  <Select
                    value={form.monthlyMode}
                    onValueChange={(v) =>
                      set({
                        monthlyMode: (v ?? "mday") as FormState["monthlyMode"],
                      })
                    }
                    items={{
                      mday: "Am Tag des Monats",
                      wday: "Am Wochentag",
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mday">Am Tag des Monats</SelectItem>
                      <SelectItem value="wday">Am Wochentag</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {form.monthlyMode === "mday" ? (
                  field(
                    "Monatstage",
                    <Input
                      value={form.byMonthDayText}
                      onChange={(e) => set({ byMonthDayText: e.target.value })}
                      placeholder="z. B. 1, 15 oder -1 (letzter)"
                      aria-label="Monatstage"
                    />,
                    monthDayHint ??
                      'Komma-getrennt, z. B. "1, 15"; -1 = letzter Tag'
                  )
                ) : (
                  <div className="flex items-end gap-2">
                    <Select
                      value={form.ordinal}
                      onValueChange={(v) => set({ ordinal: v ?? "1" })}
                      items={{
                        "1": "1.",
                        "2": "2.",
                        "3": "3.",
                        "4": "4.",
                        "-1": "letzte",
                      }}
                    >
                      <SelectTrigger aria-label="Ordnung">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">1.</SelectItem>
                        <SelectItem value="2">2.</SelectItem>
                        <SelectItem value="3">3.</SelectItem>
                        <SelectItem value="4">4.</SelectItem>
                        <SelectItem value="-1">letzte</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={form.ordinalDay}
                      onValueChange={(v) => set({ ordinalDay: v ?? "MO" })}
                      items={Object.fromEntries(
                        WEEKDAY_CHIPS.map((c) => [c.value, c.label])
                      )}
                    >
                      <SelectTrigger aria-label="Wochentag">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAY_CHIPS.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            {form.freq === "YEARLY" && (
              <div className="space-y-3">
                <div
                  className="flex flex-wrap gap-1.5"
                  role="group"
                  aria-label="Monate"
                >
                  {MONTH_CHIPS.map((label, i) => {
                    const value = String(i + 1)
                    const active = form.byMonth.includes(value)
                    return (
                      <Button
                        key={value}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        aria-pressed={active}
                        onClick={() =>
                          set({
                            byMonth: active
                              ? form.byMonth.filter((m) => m !== value)
                              : [...form.byMonth, value],
                          })
                        }
                      >
                        {label}
                      </Button>
                    )
                  })}
                </div>
                {form.byMonth.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Kein Monat gewählt — BYMONTH entfällt und die Regel liefert
                    (bei Tag-Muster) nur im Januar.
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  {field(
                    "Muster",
                    <Select
                      value={form.yearlyMode}
                      onValueChange={(v) =>
                        set({
                          yearlyMode: (v ?? "mday") as FormState["yearlyMode"],
                        })
                      }
                      items={{
                        mday: "Am Tag des Monats",
                        wday: "Am Wochentag",
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mday">Am Tag des Monats</SelectItem>
                        <SelectItem value="wday">Am Wochentag</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  {form.yearlyMode === "mday" ? (
                    field(
                      "Tag",
                      <Input
                        value={form.yearlyMonthDayText}
                        onChange={(e) =>
                          set({ yearlyMonthDayText: e.target.value })
                        }
                        placeholder="z. B. 1 oder -1"
                        aria-label="Tag im Monat"
                      />
                    )
                  ) : (
                    <div className="flex items-end gap-2">
                      <Select
                        value={form.ordinal}
                        onValueChange={(v) => set({ ordinal: v ?? "1" })}
                        items={{
                          "1": "1.",
                          "2": "2.",
                          "3": "3.",
                          "4": "4.",
                          "-1": "letzte",
                        }}
                      >
                        <SelectTrigger aria-label="Ordnung">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1.</SelectItem>
                          <SelectItem value="2">2.</SelectItem>
                          <SelectItem value="3">3.</SelectItem>
                          <SelectItem value="4">4.</SelectItem>
                          <SelectItem value="-1">letzte</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select
                        value={form.ordinalDay}
                        onValueChange={(v) => set({ ordinalDay: v ?? "MO" })}
                        items={Object.fromEntries(
                          WEEKDAY_CHIPS.map((c) => [c.value, c.label])
                        )}
                      >
                        <SelectTrigger aria-label="Wochentag">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAY_CHIPS.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {field(
            "RRULE (erweitert)",
            <Input
              className="font-mono text-xs"
              spellCheck={false}
              value={form.rawDirty ? form.rawRrule : (effectiveRrule ?? "")}
              onChange={(e) =>
                set({ rawRrule: e.target.value, rawDirty: true })
              }
              placeholder="FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1"
              aria-label="RRULE"
            />
          )}

          <div className="rounded-md bg-muted/50 p-3 text-sm">
            {preview.error ? (
              <span className="text-destructive">{preview.error}</span>
            ) : preview.dates.length > 0 ? (
              <span>
                <Badge variant="outline" className="mr-2 font-normal">
                  Vorschau
                </Badge>
                {preview.dates.map((d) => (
                  <span key={d} className="mr-2 tabular-nums">
                    {d.split("-").reverse().join(".")}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">Keine Termine.</span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Abbrechen
          </Button>
          <Button onClick={() => void save()} disabled={busy || !canSave}>
            {busy ? "Speichern…" : isEdit ? "Speichern" : "Anlegen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
