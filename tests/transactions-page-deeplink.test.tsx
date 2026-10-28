// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { waitFor } from "@testing-library/react"

const mockSearchParams = { current: new URLSearchParams() }
const mockPush = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockSearchParams.current,
  usePathname: () => "/transactions",
}))

import TransactionsPage from "@/app/transactions/page"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

const TX_ROW = {
  id: "tx-deep-1",
  bookingDate: "2026-11-04",
  valueDate: null,
  status: "Gebucht",
  payer: "Max Mustermann",
  payee: "Mietwerk GmbH",
  purpose: "Miete",
  type: "Ausgang",
  counterpartyIban: "DE",
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

beforeEach(() => {
  stubLocalStorage()
  ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
    vi.fn()
  mockPush.mockReset()
  mockSearchParams.current = new URLSearchParams()
})

describe("transactions page with ?tx= deep link (full page flow)", () => {
  it("renders FilterBar + table and queries the focused row by id", async () => {
    mockSearchParams.current = new URLSearchParams({ tx: "tx-deep-1" })
    const stub = stubFetch([
      {
        url: /\/api\/accounts$/,
        json: {
          accounts: [
            {
              id: 1,
              userId: 1,
              iban: "DE01",
              name: "Girokonto",
              createdAt: "x",
            },
          ],
        },
      },
      { url: /\/api\/categories$/, json: { categories: [] } },
      {
        url: /\/api\/transactions$/,
        json: { rows: [TX_ROW], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(<TransactionsPage />)
    // the deep link surfaced the row (expanded + highlighted)
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    expect(stub.calls.some((c) => c.url.includes("id=tx-deep-1"))).toBe(true)
    expect(container.querySelector("tr[data-focus]")).not.toBeNull()
    expect(document.getElementById("tx-details-tx-deep-1")).not.toBeNull()
  })

  it("renders the regular list without a tx param (no id query)", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/accounts$/,
        json: { accounts: [] },
      },
      { url: /\/api\/categories$/, json: { categories: [] } },
      {
        url: /\/api\/transactions$/,
        json: { rows: [TX_ROW], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(<TransactionsPage />)
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    expect(stub.calls.some((c) => c.url.includes("id="))).toBe(false)
    expect(container.querySelector("tr[data-focus]")).toBeNull()
  })
})
