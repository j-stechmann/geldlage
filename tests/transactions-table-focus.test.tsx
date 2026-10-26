// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { waitFor } from "@testing-library/react"
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

const ROW_B = {
  ...ROW_A,
  id: "tx-2",
  amountCents: -100_00,
  purpose: "Sonstiges",
}

beforeEach(() => {
  stubLocalStorage()
  // jsdom has no scrollIntoView at all
  ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
    vi.fn()
})

describe("TransactionsTable focusTxId (deep link from /planung)", () => {
  it("queries the single row by id, then expands and highlights it", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
    // rows loaded
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    // the table fetched THE row via the id lookup — not the filter pipeline
    expect(stub.calls.some((c) => c.url.includes("id=tx-1"))).toBe(true)
    // the focused row is marked and its detail row is expanded immediately
    // (render-time adjustment, no click needed)
    const focused = container.querySelector("tr[data-focus]")
    expect(focused).not.toBeNull()
    expect(focused!.outerHTML).toContain('data-focus="')
    expect(document.getElementById("tx-details-tx-1")).not.toBeNull()
  })

  it("leaves rows collapsed/unhighlighted without a focus param", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A, ROW_B], total: 2, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} />
    )
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    // no focus → normal filter query, no id param, no highlight/expansion
    expect(stub.calls.some((c) => c.url.includes("id="))).toBe(false)
    expect(container.querySelector("tr[data-focus]")).toBeNull()
    expect(document.getElementById("tx-details-tx-1")).toBeNull()
    expect(document.getElementById("tx-details-tx-2")).toBeNull()
  })
})
