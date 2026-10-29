// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"
import { TransactionsTable } from "@/components/transactions-table"
import { EMPTY_FILTERS } from "@/lib/filters"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"
import type { PlanOccurrence } from "@/components/planning/api"

const ROW_A = {
  id: "tx-1",
  bookingDate: "2026-11-04",
  valueDate: null,
  status: "Gebucht",
  payer: "Max Mustermann",
  payee: "Mietwerk GmbH",
  purpose: "Miete",
  type: "Ausgang",
  counterpartyIban: "DE02120300000000202051",
  amountCents: -950_00,
  creditorId: null,
  mandateRef: null,
  customerRef: null,
  accountId: 1,
  accountName: "Girokonto",
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  labelStatus: "labeled",
}

const PLAN_ROW = {
  id: "plan-1",
  accountId: 1,
  accountName: "Girokonto",
  counterparty: "Mietwerk GmbH",
  purpose: "Miete",
  amountCents: -950_00,
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  dtstart: "2026-10-04",
  rrule: "FREQ=MONTHLY;BYMONTHDAY=4",
  status: "active",
  notes: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
}

function matchedOccurrence(): PlanOccurrence {
  return {
    id: "plan-1::2026-11-04",
    planId: "plan-1",
    date: "2026-11-04",
    amountCents: -950_00,
    counterparty: "Mietwerk GmbH",
    purpose: "Miete",
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    accountId: 1,
    planStatus: "active",
    matched: {
      transactionId: "tx-1",
      bookingDate: "2026-11-04",
      amountCents: -950_00,
    },
  }
}

/**
 * The plan-affordance entry in the expanded detail row: unmatched rows
 * offer "In Planung umwandeln" (dialog pre-filled with the row's data and
 * the monthly day-of-month guess) and rows the read-time match already
 * claimed offer "Plan bearbeiten" for that plan instead — converting would
 * only duplicate it. While the ± posting-drift reverse lookup is still in
 * flight the button is disarmed.
 */
describe("TransactionsTable plan-affordance entry", () => {
  beforeEach(() => {
    stubLocalStorage()
    // jsdom has no scrollIntoView at all
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
      vi.fn()
  })

  function renderTable() {
    return renderWithQuery(
      // focusTxId auto-expands the detail row (deep-link mode)
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
  }

  async function affordanceButton(label: string) {
    return await waitFor(() => {
      const btn = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent?.includes(label)
      )
      expect(btn, `${label} button should be rendered`).toBeTruthy()
      return btn as HTMLButtonElement
    })
  }

  async function inputByLabel(label: string): Promise<HTMLInputElement> {
    return (await waitFor(() => {
      const el = document.body.querySelector(
        `input[aria-label="${label}"]`
      ) as HTMLInputElement | null
      expect(el, `${label} input should be rendered`).toBeTruthy()
      return el
    })) as HTMLInputElement
  }

  it("an unmatched row opens the plan dialog pre-filled from the transaction", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      // the ± posting-drift reverse lookup answers: no occurrence matches
      { url: /\/api\/plans\/occurrences$/, json: { occurrences: [] } },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    const convert = await affordanceButton("In Planung umwandeln")
    // disarmed while the reverse lookup resolves — wait for the armed state
    // so the click cannot fall through
    await waitFor(() => expect(convert.disabled).toBe(false))
    fireEvent.click(convert)

    // the dialog opens with the row's data pre-filled: payee of the
    // outgoing row as counterparty, German-formatted amount, the booking
    // day as a monthly BYMONTHDAY guess
    const counterparty = await inputByLabel("Vertragspartner")
    expect(counterparty.value).toBe("Mietwerk GmbH")
    expect((await inputByLabel("Betrag")).value).toBe("950,00")
    const rrule = await inputByLabel("RRULE")
    expect(rrule.value).toBe("FREQ=MONTHLY;BYMONTHDAY=4")
  })

  it("a matched row opens the matching plan's edit dialog instead", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      {
        url: /\/api\/plans\/occurrences$/,
        json: { occurrences: [matchedOccurrence()] },
      },
      { url: /\/api\/plans$/, json: { plans: [PLAN_ROW] } },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    const edit = await affordanceButton("Plan bearbeiten")
    await waitFor(() => expect(edit.disabled).toBe(false))
    // converting is gone for matched rows — no duplicate-plan path
    expect(
      Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("In Planung umwandeln")
      )
    ).toBeUndefined()
    fireEvent.click(edit)

    // EDIT mode ("Speichern", not "Anlegen") with the stored plan's data
    const save = await affordanceButton("Speichern")
    expect(save.textContent).toContain("Speichern")
    expect(
      Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Anlegen")
      )
    ).toBeUndefined()
    const counterparty = await inputByLabel("Vertragspartner")
    expect(counterparty.value).toBe("Mietwerk GmbH")
    expect((await inputByLabel("Betrag")).value).toBe("950,00")
    const rrule = await inputByLabel("RRULE")
    expect(rrule.value).toBe("FREQ=MONTHLY;BYMONTHDAY=4")
  })

  it("a failed reverse lookup falls back to the convert affordance", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      // e.g. window_too_far: the matching engine could not be consulted —
      // the affordance must not hide away (convert stays offered)
      { url: /\/api\/plans\/occurrences$/, json: {}, status: 400 },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    const convert = await affordanceButton("In Planung umwandeln")
    await waitFor(() => expect(convert.disabled).toBe(false))
    fireEvent.click(convert)
    await inputByLabel("Vertragspartner")
  })
})
