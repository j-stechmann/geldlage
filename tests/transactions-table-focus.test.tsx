// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { waitFor } from "@testing-library/react"
import { TransactionsTable } from "@/components/transactions-table"
import { EMPTY_FILTERS, type TableFilters } from "@/lib/filters"
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

/** A non-default listing context (the deep link almost always clears these). */
const FILTERED: TableFilters = { ...EMPTY_FILTERS, q: "sonst" }

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

  it("names the miss when the focused transaction does not exist", async () => {
    // a stale/deleted deep-link target must not render the generic empty
    // listing under the "nur diese Transaktion" badge — the user clicked a
    // concrete chip in /planung and deserves to know THAT row is gone
    const stub = stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [], total: 0, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-gone" />
    )
    await waitFor(() => {
      expect(container.textContent).toContain("Transaktion nicht gefunden")
    })
    expect(container.textContent).not.toContain("CSV-Datei")
    expect(stub.calls.some((c) => c.url.includes("id=tx-gone"))).toBe(true)
  })

  it("trims a whitespace-padded focus param before lookup and row match", async () => {
    // the server trims the id before lookup (app/api/transactions/route.ts);
    // the client must trim the focus param too, or the fetch succeeds (server
    // trims) while the row.id match fails — highlight/expansion silently dead
    const stub = stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="  tx-1  " />
    )
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    // the wire form is the trimmed id — padded input would encode as
    // "id=+tx-1+" (URLSearchParams) — and the trimmed value matches row.id
    expect(stub.calls.some((c) => c.url.includes("id=tx-1"))).toBe(true)
    expect(
      stub.calls.some(
        (c) => c.url.includes("%20tx-1") || c.url.includes("+tx-1")
      )
    ).toBe(false)
    expect(container.querySelector("tr[data-focus]")).not.toBeNull()
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

  it("disables the dead pager in focus mode (the id lookup ignores page state)", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    const buttons = Array.from(container.querySelectorAll("button"))
    const back = buttons.find((b) => b.textContent?.trim() === "Zurück")
    const next = buttons.find((b) => b.textContent?.trim() === "Weiter")
    expect(back).toBeTruthy()
    expect(next).toBeTruthy()
    // the query params in focus mode never read `page`, so the controls
    // would be clickable no-ops around a stale "N / 1" — they disable and
    // the indicator reads "Fokus" instead
    expect(back).toBeDisabled()
    expect(next).toBeDisabled()
    const pagerText = back!.parentElement!.textContent ?? ""
    expect(pagerText).toContain("Fokus")
    expect(pagerText).not.toContain("/")
  })

  it("disables the column-header sort buttons in focus mode (dead like the sort dropdown)", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    // header buttons read the visible default columns; the id lookup ignores
    // every sort, so a header click would silently mutate the sort that only
    // applies again after leaving focus mode — same dead-control rule as the
    // disabled sort dropdown
    for (const label of ["Buchung", "Betrag"]) {
      const header = Array.from(
        container.querySelectorAll("thead button")
      ).find((b) => b.textContent?.trim() === label)
      expect(header).toBeTruthy()
      expect(header).toBeDisabled()
    }
  })

  it("keeps the column-header sort buttons clickable without a focus param", async () => {
    stubFetch([
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
    const header = Array.from(container.querySelectorAll("thead button")).find(
      (b) => b.textContent?.trim() === "Buchung"
    )
    expect(header).toBeTruthy()
    expect(header).not.toBeDisabled()
  })

  it("keeps the focus expansion when the filter mirror lands a commit after the deep link", async () => {
    // in-place URL transition to ?tx=<id> with the table already mounted: the
    // page adopts the new URL filters (which the tx param cleared) in an
    // effect one commit AFTER focusTxId arrives — the listing-context reset
    // in that trailing commit must not wipe the expansion the focus sync
    // just applied (the id lookup ignores the listing context entirely)
    const stub = stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { rerender, container } = renderWithQuery(
      <TransactionsTable filters={FILTERED} />
    )
    // commit 1: URL switched to ?tx=…, the filter mirror still holds FILTERED
    rerender(<TransactionsTable filters={FILTERED} focusTxId="tx-1" />)
    // commit 2: the page's effect adopts the new URL filters
    rerender(<TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />)
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })
    expect(stub.calls.some((c) => c.url.includes("id=tx-1"))).toBe(true)
    expect(container.querySelector("tr[data-focus]")).not.toBeNull()
    expect(document.getElementById("tx-details-tx-1")).not.toBeNull()
  })

  it("clears the focus expansion when the tx param drops", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { rerender, container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
    await waitFor(() => {
      expect(document.getElementById("tx-details-tx-1")).not.toBeNull()
    })
    rerender(<TransactionsTable filters={EMPTY_FILTERS} focusTxId={null} />)
    expect(container.querySelector("tr[data-focus]")).toBeNull()
    expect(document.getElementById("tx-details-tx-1")).toBeNull()
  })

  it("leaves no stale expansion when a filter edit exits focus mode across its two commits", async () => {
    // a filter edit lands in two commits locally: the filter state changes
    // first (the tx param still on the URL — the reset is gated while
    // focused), then the URL commit drops the tx param, which must clear the
    // focused row's expansion so it cannot leak into the following listing
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
    ])
    const { rerender, container } = renderWithQuery(
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
    await waitFor(() => {
      expect(document.getElementById("tx-details-tx-1")).not.toBeNull()
    })
    // commit 1: filter state changed, URL (and tx param) not yet committed
    rerender(<TransactionsTable filters={FILTERED} focusTxId="tx-1" />)
    // commit 2: the URL commit drops the tx param
    rerender(<TransactionsTable filters={FILTERED} focusTxId={null} />)
    expect(container.querySelector("tr[data-focus]")).toBeNull()
    expect(document.getElementById("tx-details-tx-1")).toBeNull()
  })
})
