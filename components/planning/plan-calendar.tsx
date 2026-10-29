"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { addDays } from "date-fns"
import { de as deLocale } from "date-fns/locale"
import { EventCalendar } from "@/components/reui/event-calendar/event-calendar"
import { EventCalendarContent } from "@/components/reui/event-calendar/event-calendar-content"
import { EventCalendarNav } from "@/components/reui/event-calendar/event-calendar-nav"
import type {
  CalendarEvent,
  CalendarView,
  EventCalendarInteractions,
  EventCalendarOccurrence,
} from "@/components/reui/event-calendar/event-calendar-types"
import {
  ApiError,
  germanDate,
  useCalendarTransactions,
  usePlanOccurrences,
  transactionDeepLink,
  type CalendarTransaction,
  type PlanOccurrence,
  type PlanPrefill,
} from "@/components/planning/api"
import { ErrorState } from "@/components/error-state"
import { isoDateLocal, todayLocal } from "@/lib/analytics/date"
import { euro } from "@/lib/money"
import { resolveCategoryColor } from "@/lib/category-colors"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PlanDialog } from "@/components/planning/plan-dialog"
import { useMatchedPlanForTx, type PlanRow } from "@/components/planning/api"

function localMidnight(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d)
}

/** Chip label: counterparty/purpose + signed, German-formatted amount. */
function chipTitle(
  entry: {
    label: string | null
    purpose: string | null
    amountCents: number
  },
  fallback: string
): string {
  const label = entry.label ?? entry.purpose ?? fallback
  return `${label} · ${euro(entry.amountCents)}`
}

/** Wash a color toward muted — the visual language for REAL BANK chips. */
function washedColor(color: string, keep: number): string {
  return `color-mix(in oklab, ${color} ${keep}%, var(--muted-foreground))`
}

interface CalendarChipData {
  /** planned occurrence (own dialog opens on click) */
  occurrence?: PlanOccurrence
  /** real bank transaction (booked or pending); click opens the action dialog,
   * whose second action (BOOKED chips only) is the matched plan's edit (or
   * the convert entry) */
  transaction?: CalendarTransaction
  /**
   * "pending" = Nicht gebucht rows: the default chip draws them with the
   * dashed provisional outline (the transactions table's pending language)
   */
  chipVariant?: "pending"
}

type OccurrenceData = CalendarChipData

/** German i18n overrides (dates Germanize via the de locale). */
const GERMAN_I18N = {
  labels: {
    today: "Heute",
    previous: "Zurück",
    next: "Weiter",
    allDay: "Ganztägig",
    noEvents: "Keine Termine",
    loading: "Lade Termine",
    selectView: "Ansicht wählen",
    more: (count: number) => `+${count} weitere`,
    events: (count: number) => (count === 1 ? "1 Termin" : `${count} Termine`),
  },
  viewNames: {
    month: "Monat",
    week: "Woche",
    day: "Tag",
    days: (count: number) => `${count} Tage`,
    agenda: "Liste",
    resource: "Zeit",
  },
  formats: {
    dayTitle: "EEEE, d. MMMM yyyy",
    agendaDayHeader: "EEEE, d. MMMM",
    moreDayHeader: "EEEE, d. MMMM",
  },
}

/**
 * Stable prop identities for the calendar: month/agenda-only views and the
 * all-off interaction set. The store's setOptions compares by identity and
 * bumps its settings version on every change — inline literals would
 * invalidate (and re-notify) once per parent render for zero effect.
 */
const CALENDAR_VIEWS: CalendarView[] = ["month", "agenda"]
const CALENDAR_INTERACTIONS: Partial<EventCalendarInteractions> = {
  drag: false,
  resize: false,
  selectSlot: false,
}
const CALENDAR_EVENT_TOOLTIP = { delay: 300 }

/**
 * Derive the plan dialog's create prefill from a calendar-booked
 * transaction (counterparty is precomputed by the API here, unlike the
 * transactions-table rows which derive it from type). accountId stays null
 * for legacy rows → the dialog selects "any account".
 */
function planPrefillFromCalendarTx(tx: CalendarTransaction): PlanPrefill {
  return {
    counterparty: tx.counterparty,
    purpose: tx.purpose,
    amountCents: tx.amountCents,
    dtstart: tx.date,
    accountId: tx.accountId,
    categoryId: tx.categoryId,
  }
}

export interface PlanCalendarProps {
  accountId: number | null
  onEventClick: (occurrence: PlanOccurrence) => void
}

/**
 * Month/list calendar. The server is the single source of truth for
 * expansion + matching (ADR-0035); the calendar renders two chip families:
 * planned occurrences (full color — muted when paused/matched, destructive
 * when überfällig) and REAL booked transactions washed toward muted
 * (color-mix). Clicks open plans; booked chips open an action dialog with
 * the transactions deep link and the convert-to-plan entry (the plan
 * dialog opens pre-filled from the clicked transaction) — or the matched
 * plan's edit entry when the booking is already read-time matched.
 * Interactions stay off by design: editing an occurrence means editing its
 * plan, never dragging (a drag would ambiguously rewrite DTSTART).
 */
export function PlanCalendar({ accountId, onEventClick }: PlanCalendarProps) {
  const router = useRouter()
  const [txAction, setTxAction] = React.useState<CalendarTransaction | null>(
    null
  )
  const [convertPrefill, setConvertPrefill] =
    React.useState<PlanPrefill | null>(null)
  // matched-plan edit target: a clicked chip whose booking the read-time
  // match already assigned to a plan opens that plan's edit dialog instead
  // of offering a convert that would duplicate it
  const [editingPlan, setEditingPlan] = React.useState<PlanRow | null>(null)
  // The chip action's plan affordance uses the same authoritative reverse
  // lookup as the transactions-table rows (window around the booking date,
  // ± posting drift) — the visible window's occurrences could miss a match
  // whose occurrence fell outside the loaded range (booking at the edge).
  // "Nicht gebucht" chips sit outside the matching engine entirely (it
  // queries status = 'Gebucht') — null ref → resolved unmatched, and the
  // dialog keeps only the deep link below.
  const actionMatch = useMatchedPlanForTx(
    txAction !== null && txAction.status === "Gebucht"
      ? { id: txAction.id, bookingDate: txAction.date }
      : null
  )
  const actionPlan = actionMatch.resolved ? actionMatch.matchedPlan : null
  // named calendarWindow (not `window`): shadowing the browser global is a
  // foot-gun for anything later reading window.* in this scope
  const [calendarWindow, setCalendarWindow] = React.useState<{
    from: string
    to: string
  } | null>(null)
  const occurrencesQuery = usePlanOccurrences(
    calendarWindow?.from ?? null,
    calendarWindow?.to ?? null,
    accountId
  )
  const bookedQuery = useCalendarTransactions(
    calendarWindow?.from ?? null,
    calendarWindow?.to ?? null,
    accountId
  )
  // failed window reads stay visible instead of rendering as an empty
  // month (the dashboard's ErrorState pattern) — placeholder data keeps a
  // possibly stale calendar visible beneath
  const calendarLoadFailed = occurrencesQuery.isError || bookedQuery.isError
  // window_too_far is NOT a transient failure: the endpoints refuse this
  // window deterministically (±MAX_WINDOW_DISTANCE_DAYS of today, docs
  // planning.md), so the shared banner's "Erneut versuchen" could never
  // succeed at that distance — the reads answer fine again as soon as the
  // user navigates back toward today (onRangeChange refetches). The hint
  // names that instead of offering a dead retry, and keeps the error
  // styling so the month still cannot read as "nothing planned".
  const windowTooFar =
    occurrencesQuery.error instanceof ApiError &&
    occurrencesQuery.error.code === "window_too_far"
  const farWindow =
    windowTooFar ||
    (bookedQuery.error instanceof ApiError &&
      bookedQuery.error.code === "window_too_far")

  const handleRangeChange = React.useCallback(
    (info: {
      range: { start: Date; end: Date }
      view: string
      date: Date
      timeZone: string
    }) => {
      // local calendar dates — toISOString() would shift the window edges
      // across UTC midnight for non-UTC timezones
      const from = isoDateLocal(info.range.start)
      const to = isoDateLocal(new Date(info.range.end.getTime() - 1))
      setCalendarWindow((prev) =>
        prev && prev.from === from && prev.to === to ? prev : { from, to }
      )
    },
    []
  )

  // local "today" — the UTC date from toISOString() miscolors overdue chips
  // around local midnight for non-UTC timezones
  const todayIso = todayLocal()

  const events = React.useMemo<CalendarEvent<OccurrenceData>[]>(() => {
    const occurrences = occurrencesQuery.data?.occurrences ?? []
    const planned = occurrences.map((o) => {
      const start = localMidnight(o.date)
      const categoryColor =
        o.categoryId !== null && o.categoryColor !== null
          ? resolveCategoryColor(o.categoryId, o.categoryColor)
          : null
      // chip color: paused/matched = muted, überfällig = destructive,
      // else the category color (primary tint when uncategorized)
      let color: string
      if (o.planStatus === "paused" || o.matched !== null) {
        color = "var(--muted-foreground)"
      } else if (o.date < todayIso) {
        color = "var(--destructive)"
      } else {
        color = categoryColor ?? "var(--primary)"
      }
      const title = chipTitle(
        {
          label: o.counterparty,
          purpose: o.purpose,
          amountCents: o.amountCents,
        },
        "Geplant"
      )
      return {
        id: o.id,
        title: o.matched !== null ? `✓ ${title}` : title,
        start,
        end: addDays(start, 1),
        allDay: true,
        readOnly: true,
        color,
        data: { occurrence: o },
      }
    })
    const booked = (bookedQuery.data?.transactions ?? []).map(
      (tx: CalendarTransaction) => {
        const start = localMidnight(tx.date)
        const base =
          tx.categoryId !== null && tx.categoryColor !== null
            ? resolveCategoryColor(tx.categoryId, tx.categoryColor)
            : "var(--primary)"
        const title = chipTitle(
          {
            label: tx.counterparty,
            purpose: tx.purpose,
            amountCents: tx.amountCents,
          },
          "Buchung"
        )
        const pending = tx.status === "Nicht gebucht"
        // booked = washed (40 %); pending = washed further (20 %), hollow
        // marker + the dashed provisional chip variant
        return {
          id: `tx::${tx.id}`,
          title: `${pending ? "◌" : "•"} ${title}`,
          start,
          end: addDays(start, 1),
          allDay: true,
          readOnly: true,
          color: washedColor(base, pending ? 20 : 40),
          data: {
            transaction: tx,
            ...(pending ? { chipVariant: "pending" as const } : {}),
          },
        }
      }
    )
    return [...planned, ...booked]
  }, [
    occurrencesQuery.data?.occurrences,
    bookedQuery.data?.transactions,
    todayIso,
  ])

  return (
    <>
      {farWindow && (
        <p className="mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Dieser Zeitraum liegt außerhalb des planbaren Fensters (±60 Monate um
          heute) — navigieren Sie im Kalender Richtung „Heute“ zurück.
        </p>
      )}
      {!farWindow && calendarLoadFailed && (
        <ErrorState
          className="mb-2"
          onRetry={() => {
            void occurrencesQuery.refetch()
            void bookedQuery.refetch()
          }}
        />
      )}
      <EventCalendar
        views={CALENDAR_VIEWS}
        defaultView="month"
        events={events}
        loading={occurrencesQuery.isLoading || bookedQuery.isLoading}
        interactions={CALENDAR_INTERACTIONS}
        enableShortcuts={false}
        eventTooltip={CALENDAR_EVENT_TOOLTIP}
        locale={deLocale}
        weekStartsOn={1}
        i18n={GERMAN_I18N}
        onRangeChange={handleRangeChange}
        onEventClick={(occurrence: EventCalendarOccurrence<OccurrenceData>) => {
          const data = occurrence.event.data
          if (data?.occurrence) {
            // plan chips open the plan dialog
            onEventClick(data.occurrence)
          } else if (data?.transaction) {
            // bank chips open an action dialog: view in the transactions
            // table, or convert into a planned transaction (pre-filled)
            setTxAction(data.transaction)
          }
        }}
        className="h-[70vh] min-h-[540px] rounded-lg border"
      >
        <EventCalendarNav />
        <EventCalendarContent />
      </EventCalendar>

      {/* booked-transaction chip action: deep-link into the transactions
          table, or convert the booking into a planned transaction */}
      <Dialog
        open={txAction !== null}
        onOpenChange={(open) => {
          if (!open) setTxAction(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Buchung umwandeln oder öffnen</DialogTitle>
            <DialogDescription>
              {txAction
                ? `${txAction.counterparty ?? "Buchung"} · ${euro(txAction.amountCents)} · ${germanDate(txAction.date)}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                // capture before clearing: the deep link needs the id, the
                // chip deep-link keeps its original user-scoped behavior
                const tx = txAction
                setTxAction(null)
                if (tx) router.push(transactionDeepLink(tx))
              }}
            >
              Buchung ansehen
            </Button>
            {/* the plan affordance lives on BOOKED chips only — "Nicht
                gebucht" chips are never paired by the matching engine, so
                converting there would orphan the plan until the booked
                version posts */}
            {txAction !== null && txAction.status === "Gebucht" ? (
              actionPlan !== null ? (
                <Button
                  onClick={() => {
                    setEditingPlan(actionPlan)
                    setTxAction(null)
                  }}
                >
                  Plan bearbeiten
                </Button>
              ) : (
                <Button
                  // disarmed while the match lookup resolves: a convert click
                  // on a matched booking would create a duplicate plan
                  disabled={!actionMatch.resolved}
                  onClick={() => {
                    const tx = txAction
                    setTxAction(null)
                    if (tx) {
                      setConvertPrefill(planPrefillFromCalendarTx(tx))
                    }
                  }}
                >
                  In Planung umwandeln
                </Button>
              )
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {convertPrefill && (
        <PlanDialog
          open
          onOpenChange={(open) => {
            if (!open) setConvertPrefill(null)
          }}
          prefill={convertPrefill}
        />
      )}

      {editingPlan && (
        <PlanDialog
          open
          plan={editingPlan}
          onOpenChange={(open) => {
            if (!open) setEditingPlan(null)
          }}
        />
      )}
    </>
  )
}
