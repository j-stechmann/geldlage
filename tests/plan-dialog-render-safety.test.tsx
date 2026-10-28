// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, beforeEach } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"
import { PlanDialog } from "@/components/planning/plan-dialog"
import {
  calendarTransactionsKey,
  forecastKey,
  planOccurrencesKey,
} from "@/components/planning/api"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

/**
 * The effectiveRrule useMemo must NEVER throw: buildRrule (via
 * parseByMonthDay) throws on month-day garbage ("0", "45", letters,
 * duplicates) — and with no error.tsx boundary anywhere in app/, an
 * uncaught render error unmounts the entire app. The throw must become
 * inline preview text plus a disabled save instead.
 */

const BASE_PLAN = {
  id: "plan-1",
  accountId: null,
  accountName: null,
  counterparty: "Mietwerk GmbH",
  purpose: null,
  amountCents: -95_000,
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  dtstart: "2026-01-01",
  status: "active" as const,
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

beforeEach(() => {
  stubLocalStorage()
  stubFetch([
    { url: /\/api\/accounts$/, json: { accounts: [] } },
    { url: /\/api\/labels$/, json: { labels: [] } },
  ])
})

function saveButton(): HTMLButtonElement {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent === "Speichern"
  )
  expect(btn, "Speichern button should be rendered").toBeTruthy()
  return btn as HTMLButtonElement
}

function inputByLabel(label: string): HTMLInputElement {
  const el = document.body.querySelector(
    `input[aria-label="${label}"]`
  ) as HTMLInputElement
  expect(el, `${label} input should be rendered`).toBeTruthy()
  return el
}

describe("plan dialog: invalid builder input must not crash the page", () => {
  it("monthly garbage shows the rule error and disables save instead of throwing", async () => {
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        }}
      />
    )
    const input = await waitFor(() => inputByLabel("Monatstage"))

    fireEvent.change(input, { target: { value: "0" } })
    // the tree is still alive here — the queries below would fail on an
    // unmounted app; the error text surfaces in the preview box, save is
    // disarmed
    await waitFor(() => {
      expect(document.body.textContent).toContain("Ungültige Monatstage")
    })
    expect(saveButton()).toBeDisabled()

    // repairing the input clears the error and re-enables the dialog
    fireEvent.change(input, { target: { value: "1, 15" } })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Ungültige Monatstage")
    })
    expect(saveButton()).toBeEnabled()
  })

  it("yearly garbage in the Tag field is contained the same way", async () => {
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          rrule: "FREQ=YEARLY;BYMONTHDAY=1",
        }}
      />
    )
    const input = await waitFor(() => inputByLabel("Tag im Monat"))

    fireEvent.change(input, { target: { value: "45" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain("Ungültige Monatstage")
    })
    expect(saveButton()).toBeDisabled()
  })

  it("an incomplete 'Am Datum' end condition is an error, not a silently unbounded rule", async () => {
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          rrule: "FREQ=MONTHLY;UNTIL=20261231T120000Z",
        }}
      />
    )
    const input = await waitFor(() => inputByLabel("Enddatum"))

    // clearing the chosen end date must NOT save an unbounded rule under a
    // form still displaying "Am Datum" — it disarms the dialog like every
    // other rule error
    fireEvent.change(input, { target: { value: "" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Enddatum fehlt oder ist ungültig"
      )
    })
    expect(saveButton()).toBeDisabled()

    // re-entering a date clears the error and re-enables the dialog
    fireEvent.change(input, { target: { value: "2026-12-31" } })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain(
        "Enddatum fehlt oder ist ungültig"
      )
    })
    expect(saveButton()).toBeEnabled()
  })

  it("an out-of-range 'Nach N Vorfällen' count is contained the same way", async () => {
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          rrule: "FREQ=DAILY;COUNT=5",
        }}
      />
    )
    const input = await waitFor(() => inputByLabel("Anzahl Vorfälle"))

    // 500 used to be silently dropped → the stored rule lost its COUNT and
    // ran unbounded; now it disarms the dialog instead
    fireEvent.change(input, { target: { value: "500" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Anzahl muss zwischen 1 und 366 liegen"
      )
    })
    expect(saveButton()).toBeDisabled()

    fireEvent.change(input, { target: { value: "12" } })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain(
        "Anzahl muss zwischen 1 und 366 liegen"
      )
    })
    expect(saveButton()).toBeEnabled()
  })

  it("a multi-byte text over its byte cap disarms save (bytes ≠ characters)", async () => {
    // the browser maxLength counts characters; the server counts UTF-8
    // bytes — 129 'ß' are well inside 128 characters yet 258 bytes. The
    // dialog's inline pre-check must catch exactly what the server would
    // reject, instead of surfacing it as a save-time 400 toast.
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{ ...BASE_PLAN, rrule: null }}
      />
    )
    const input = await waitFor(() => inputByLabel("Vertragspartner"))

    fireEvent.change(input, { target: { value: "ß".repeat(129) } })
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Vertragspartner ist zu lang: 258 Bytes, max. 128"
      )
    })
    expect(saveButton()).toBeDisabled()

    // a repaired, byte-clean name re-enables the dialog — and multi-byte
    // content exactly AT the cap stays acceptable: 64 × 'ß' = 128 bytes
    fireEvent.change(input, {
      target: { value: "ß".repeat(64) },
    })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain(
        "Vertragspartner ist zu lang"
      )
    })
    expect(saveButton()).toBeEnabled()

    // the sibling caps also disarm: purpose/notes have no smaller maxlength
    const notes = inputByLabel("Notizen")
    fireEvent.change(notes, { target: { value: "é".repeat(251) } })
    await waitFor(() => {
      expect(document.body.textContent).toContain("Notizen ist zu lang")
    })
    expect(saveButton()).toBeDisabled()
    fireEvent.change(notes, { target: { value: "" } })
    await waitFor(() => expect(saveButton()).toBeEnabled())
  })

  it("an 'Alle' interval beyond 100 fails inline, not as a save-time 400", async () => {
    // the input handler clamps only the low end; a typed 500 used to leave a
    // green preview while the server capped INTERVAL at 100 — save then
    // failed with a generic toast. It must disarm the dialog like COUNT does.
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        }}
      />
    )
    const input = await waitFor(() => inputByLabel("Intervall"))

    fireEvent.change(input, { target: { value: "500" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Intervall muss zwischen 1 und 100 liegen"
      )
    })
    expect(saveButton()).toBeDisabled()

    fireEvent.change(input, { target: { value: "2" } })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain(
        "Intervall muss zwischen 1 und 100 liegen"
      )
    })
    expect(saveButton()).toBeEnabled()
  })

  it("a zero amount disarms save inline instead of a save-time 400", async () => {
    // validatePlanInput rejects amount_cents = 0 (invalid_amount) — "0,00"
    // used to keep the save button armed and surfaced only as the generic
    // 400 toast. The dialog must show the field error and disarm like the
    // byte caps do.
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{ ...BASE_PLAN, rrule: null }}
      />
    )
    const input = await waitFor(() => inputByLabel("Betrag"))
    // the prefilled -95 € amount keeps the button armed before the change
    expect(saveButton()).toBeEnabled()

    fireEvent.change(input, { target: { value: "0,00" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain("Betrag darf nicht 0 sein")
    })
    expect(saveButton()).toBeDisabled()

    // a repair re-arms — even a 1-cent amount is a valid plan
    fireEvent.change(input, { target: { value: "0,01" } })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain(
        "Betrag darf nicht 0 sein"
      )
    })
    expect(saveButton()).toBeEnabled()

    // the bare "0" is caught the same way
    fireEvent.change(input, { target: { value: "0" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain("Betrag darf nicht 0 sein")
    })
    expect(saveButton()).toBeDisabled()
  })

  it("a sparse-but-live rule previews its real next dates (ladder, not a 400-day window)", async () => {
    // leap-day yearly plan anchored in a non-leap year: the first occurrence
    // (2028-02-29) is > 2 years after dtstart — a fixed 400-day preview
    // window used to falsely claim "keinen Termin"; the preview now walks
    // the same bounded ladder as the server's validation and shows 2028 /
    // 2032 / 2036
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          dtstart: "2026-06-15",
          rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
        }}
      />
    )
    await waitFor(() => {
      expect(document.body.textContent).toContain("29.02.2028")
    })
    expect(document.body.textContent).toContain("29.02.2032")
    expect(document.body.textContent).not.toContain("erzeugt keinen Termin")
    expect(saveButton()).toBeEnabled()
  })

  it("no-month YEARLY hints are mode-accurate (copy once swapped the modes)", async () => {
    // mday: every month (the old text wrongly said "nur im Januar")
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          dtstart: "2026-06-15",
          rrule: "FREQ=YEARLY;BYMONTHDAY=15",
        }}
      />
    )
    await waitFor(() => {
      expect(document.body.textContent).toContain("jedem Monat wieder")
    })
    expect(document.body.textContent).not.toContain("nur im Januar")
  })
})

describe("plan dialog: raw RRULE mode validates exactly like the server", () => {
  /**
   * The raw text is authoritative — an invalid raw rule used to stay
   * saveable until the request 400'd (toast). It must disarm the dialog
   * (inline preview error + disabled save) like every builder-mode rule
   * error, because save() only guards on effective.error.
   */
  const EDITABLE_PLAN = {
    ...BASE_PLAN,
    rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
  }

  function selectTriggerText(label: string): string {
    const labelEl = Array.from(document.body.querySelectorAll("label")).find(
      (el) => el.textContent?.startsWith(label)
    )
    expect(labelEl, `${label} field should be rendered`).toBeTruthy()
    const trigger = labelEl!.querySelector('[data-slot="select-trigger"]')
    expect(trigger).toBeTruthy()
    return trigger!.textContent ?? ""
  }

  it("unparseable raw text disarms save; a repaired raw rule re-arms", async () => {
    renderWithQuery(
      <PlanDialog open onOpenChange={() => {}} plan={EDITABLE_PLAN} />
    )
    const raw = await waitFor(() => inputByLabel("RRULE"))

    fireEvent.change(raw, { target: { value: "garbage" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Wiederholungsregel ist ungültig"
      )
    })
    expect(saveButton()).toBeDisabled()

    // a raw rule the server would accept re-arms the dialog
    fireEvent.change(raw, { target: { value: "FREQ=DAILY" } })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain(
        "Wiederholungsregel ist ungültig"
      )
    })
    expect(saveButton()).toBeEnabled()
  })

  it("a parseable but disallowed rule (BYWEEKNO) disarms save the same way", async () => {
    // full validateRrule parity, not just parseability: rrule parses
    // BYWEEKNO fine, the server allowlist rejects it
    renderWithQuery(
      <PlanDialog open onOpenChange={() => {}} plan={EDITABLE_PLAN} />
    )
    const raw = await waitFor(() => inputByLabel("RRULE"))
    fireEvent.change(raw, {
      target: { value: "FREQ=MONTHLY;BYWEEKNO=10" },
    })
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Wiederholungsregel ist ungültig"
      )
    })
    expect(saveButton()).toBeDisabled()
  })

  it("a valid but unproductive rule (UNTIL before dtstart) disarms save too", async () => {
    // validateRrule passes (correct — it validates the rule's SHAPE, not
    // its productivity); the rule produces no occurrence at/after dtstart.
    // Only the preview's no-occurrence error knows — save must follow it,
    // not just effective.error, or the dialog reads green and the first
    // feedback is the server's generic invalid_rrule 400 toast.
    renderWithQuery(
      <PlanDialog open onOpenChange={() => {}} plan={EDITABLE_PLAN} />
    )
    const raw = await waitFor(() => inputByLabel("RRULE"))
    fireEvent.change(raw, {
      target: { value: "FREQ=DAILY;UNTIL=20200101T120000Z" },
    })
    // NOT "Wiederholungsregel ist ungültig" — the rule shape is valid; the
    // preview carries the honest "keinen Termin" error instead
    await waitFor(() => {
      expect(document.body.textContent).toContain("erzeugt keinen Termin")
    })
    expect(saveButton()).toBeDisabled()
  })

  it("clearing the raw text reads as 'Einmalig', not the stale FREQ", async () => {
    // clearing the raw RRULE saves rrule: null → the plan becomes one-off.
    // The dormant builder select must not keep displaying "Monatlich"
    // while the effective rule is once — the display follows the raw text.
    renderWithQuery(
      <PlanDialog open onOpenChange={() => {}} plan={EDITABLE_PLAN} />
    )
    const raw = await waitFor(() => inputByLabel("RRULE"))

    // while raw mode is active the select shows the raw rule's FREQ…
    fireEvent.change(raw, { target: { value: "freq=daily" } })
    await waitFor(() => {
      expect(selectTriggerText("Wiederholung")).toContain("Täglich")
    })

    // …and an empty raw text is a one-off plan, displayed as such
    fireEvent.change(raw, { target: { value: "" } })
    await waitFor(() => {
      const text = selectTriggerText("Wiederholung")
      expect(text).toContain("Einmalig")
      expect(text).not.toContain("Monatlich")
    })
    // one-off with valid amount/dtstart stays saveable
    expect(saveButton()).toBeEnabled()
  })
})

describe("plan dialog: saving fans the mutation out to the planning caches", () => {
  /**
   * invalidatePlans (["plans"], ["plan-occurrences"], ["forecast"],
   * ["transactions-calendar"]) used to run only for the board's own
   * status-toggle/delete paths — the dialog's create/update left every
   * planning cache stale. The app runs staleTime 5s +
   * refetchOnWindowFocus:false, so board, calendar chips and forecast kept
   * showing pre-mutation data until the affected queries remounted
   * (navigate away and back).
   */
  const EDITABLE_PLAN = {
    ...BASE_PLAN,
    rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
  }

  it("edit save invalidates all four planning cache families", async () => {
    const { queryClient } = renderWithQuery(
      <PlanDialog open onOpenChange={() => {}} plan={EDITABLE_PLAN} />
    )

    // pre-seed every affected cache: with no subscribers,
    // invalidateQueries marks each query invalidated and nothing refetches
    // — exactly the observable state we assert
    queryClient.setQueryData(["plans"], { plans: [] })
    const occKey = planOccurrencesKey("2026-01-01", "2026-03-31", null)
    queryClient.setQueryData(occKey, { occurrences: [] })
    const calKey = calendarTransactionsKey("2026-01-01", "2026-03-31", null)
    queryClient.setQueryData(calKey, { transactions: [] })
    const fcKey = forecastKey(12, null)
    queryClient.setQueryData(fcKey, {})

    stubFetch([
      { url: /\/api\/plans\/plan-1$/, method: "PATCH", json: { plan: {} } },
    ])

    // happy-path save: EDITABLE_PLAN has pre-filled amount/dtstart/rrule
    fireEvent.click(saveButton())

    await waitFor(() => {
      expect(queryClient.getQueryState(["plans"])?.isInvalidated).toBe(true)
    })
    expect(queryClient.getQueryState(occKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(calKey)?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(fcKey)?.isInvalidated).toBe(true)
  })
})
