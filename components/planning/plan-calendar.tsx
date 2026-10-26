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
  EventCalendarOccurrence,
} from "@/components/reui/event-calendar/event-calendar-types"
import {
  useCalendarTransactions,
  usePlanOccurrences,
  transactionDeepLink,
  type CalendarTransaction,
  type PlanOccurrence,
} from "@/components/planning/api"
import { ErrorState } from "@/components/error-state"
import { isoDateLocal, todayLocal } from "@/lib/analytics/date"
import { euro } from "@/lib/money"
import { resolveCategoryColor } from "@/lib/category-colors"

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
  /** real bank transaction (booked or pending); no dialog opens */
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

export interface PlanCalendarProps {
  accountId: number | null
  onEventClick: (occurrence: PlanOccurrence) => void
}

/**
 * Month/list calendar. The server is the single source of truth for
 * expansion + matching (ADR-0035); the calendar renders two chip families:
 * planned occurrences (full color — muted when paused/matched, destructive
 * when überfällig) and REAL booked transactions washed toward muted
 * (color-mix). Clicks only open plans; booked chips carry no dialog.
 * Interactions stay off by design: editing an occurrence means editing its
 * plan, never dragging (a drag would ambiguously rewrite DTSTART).
 */
export function PlanCalendar({ accountId, onEventClick }: PlanCalendarProps) {
  const router = useRouter()
  const [window, setWindow] = React.useState<{
    from: string
    to: string
  } | null>(null)
  const occurrencesQuery = usePlanOccurrences(
    window?.from ?? null,
    window?.to ?? null,
    accountId
  )
  const bookedQuery = useCalendarTransactions(
    window?.from ?? null,
    window?.to ?? null,
    accountId
  )
  // failed window reads stay visible instead of rendering as an empty
  // month (the dashboard's ErrorState pattern) — placeholder data keeps a
  // possibly stale calendar visible beneath
  const calendarLoadFailed = occurrencesQuery.isError || bookedQuery.isError

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
      setWindow((prev) =>
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
      {calendarLoadFailed && (
        <ErrorState
          className="mb-2"
          onRetry={() => {
            void occurrencesQuery.refetch()
            void bookedQuery.refetch()
          }}
        />
      )}
      <EventCalendar
        views={["month", "agenda"]}
        defaultView="month"
        events={events}
        loading={occurrencesQuery.isLoading || bookedQuery.isLoading}
        interactions={{ drag: false, resize: false, selectSlot: false }}
        enableShortcuts={false}
        eventTooltip={{ delay: 300 }}
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
            // bank chips deep-link into the transactions table with the row
            // surfaced (expanded, highlighted) — the id lookup is user-scoped
            // and independent of any filter state
            router.push(transactionDeepLink(data.transaction))
          }
        }}
        className="h-[70vh] min-h-[540px] rounded-lg border"
      >
        <EventCalendarNav />
        <EventCalendarContent />
      </EventCalendar>
    </>
  )
}
