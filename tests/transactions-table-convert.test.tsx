// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"
import { TransactionsTable } from "@/components/transactions-table"
import { EMPTY_FILTERS } from "@/lib/filters"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

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

/**
 * The "In Planung umwandeln" entry in the expanded detail row: clicking it
 * opens the plan dialog pre-filled with the row's data and the monthly
 * day-of-month guess — the starting point for the rent that will keep
 * recurring.
 */
describe("TransactionsTable convert-to-plan entry", () => {
  beforeEach(() => {
    stubLocalStorage()
    // jsdom has no scrollIntoView at all
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
      vi.fn()
  })

  it("opens the plan dialog pre-filled from the transaction", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderWithQuery(
      // focusTxId auto-expands the detail row (deep-link mode)
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
    const convert = await waitFor(() => {
      const btn = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("In Planung umwandeln")
      )
      expect(btn, "convert button should be rendered").toBeTruthy()
      return btn as HTMLButtonElement
    })
    fireEvent.click(convert)

    // the dialog opens with the row's data pre-filled: payee of the
    // outgoing row as counterparty, German-formatted amount, the booking
    // day as a monthly BYMONTHDAY guess
    const counterparty = (await waitFor(() => {
      const el = document.body.querySelector(
        'input[aria-label="Vertragspartner"]'
      ) as HTMLInputElement | null
      expect(el, "dialog should be open").toBeTruthy()
      return el as HTMLInputElement
    })) as HTMLInputElement
    expect(counterparty.value).toBe("Mietwerk GmbH")
    const amount = document.body.querySelector(
      'input[aria-label="Betrag"]'
    ) as HTMLInputElement
    expect(amount.value).toBe("950,00")
    const rrule = document.body.querySelector(
      'input[aria-label="RRULE"]'
    ) as HTMLInputElement
    expect(rrule.value).toBe("FREQ=MONTHLY;BYMONTHDAY=4")
  })
})
