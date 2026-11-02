// @vitest-environment jsdom
import React from "react"
import { describe, it, expect } from "vitest"
import { act, fireEvent, waitFor } from "@testing-library/react"
import { PlansList } from "@/components/planning/plans-list"
import { renderWithQuery, stubFetch } from "./helpers-dom"

/**
 * /plans is a server-paged table: search, status and page serialize into the
 * /api/plans query string, failed reads surface the shared ErrorState, and
 * empty states distinguish "no plans at all" from "no search hits".
 */

const EMPTY_PAGE = { plans: [], total: 0, page: 1, pageCount: 1 }

const ONE_PAGE = {
  plans: [
    {
      id: "plan-1",
      accountId: null,
      accountName: null,
      counterparty: "Mietwerk GmbH",
      purpose: "Miete Januar",
      amountCents: -9950,
      categoryId: null,
      categoryName: null,
      categoryColor: null,
      dtstart: "2026-01-01",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
      status: "active",
      notes: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextDueDate: "2026-11-01",
    },
  ],
  total: 1,
  page: 1,
  pageCount: 1,
}

const ERROR_TEXT = "Daten konnten nicht geladen werden."

describe("PlansList", () => {
  it("shows the ErrorState instead of the empty-plan copy on a failed read", async () => {
    stubFetch([{ url: /\/api\/plans$/, status: 500 }])
    const { container } = renderWithQuery(<PlansList />)
    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    expect(container.textContent).not.toContain("Noch keine Pläne angelegt")
  })

  it("surfaces a failed background refetch instead of serving stale rows silently", async () => {
    stubFetch([
      { url: /\/api\/plans$/, json: ONE_PAGE, once: true },
      { url: /\/api\/plans$/, status: 500 },
    ])
    const { container, queryClient } = renderWithQuery(<PlansList />)
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })

    // an invalidate-driven refetch (delete/status change) fails while the
    // last successful page is still cached: the stale row may stay readable,
    // but the failure must not read as success
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["plans"] })
    })
    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    expect(container.textContent).toContain("Mietwerk GmbH")
  })

  it("distinguishes a genuinely empty list from an empty search result", async () => {
    stubFetch([
      { url: /\/api\/plans$/, json: ONE_PAGE, once: true },
      { url: /\/api\/plans$/, json: EMPTY_PAGE },
    ])
    const { container, getByLabelText } = renderWithQuery(<PlansList />)
    await waitFor(() => {
      expect(container.textContent).toContain("Mietwerk GmbH")
    })

    fireEvent.change(getByLabelText("Pläne durchsuchen"), {
      target: { value: "Versicherung" },
    })
    await waitFor(() => {
      expect(container.textContent).toContain("Keine Pläne gefunden.")
    })
    expect(container.textContent).not.toContain("Noch keine Pläne angelegt")
  })

  it("serializes the debounced search and the page into the API query", async () => {
    const stub = stubFetch([
      { url: /\/api\/plans$/, json: { ...ONE_PAGE, pageCount: 2, total: 21 } },
    ])
    const { getByLabelText, getByRole } = renderWithQuery(<PlansList />)

    await waitFor(() => {
      expect(
        stub.calls.filter((c) => c.url.split("?")[0] === "/api/plans")
      ).toHaveLength(1)
    })
    expect(stub.calls[0].url).toContain("page=1")
    expect(stub.calls[0].url).toContain("pageSize=20")

    fireEvent.change(getByLabelText("Pläne durchsuchen"), {
      target: { value: "  Miete  " },
    })
    await waitFor(() => {
      expect(
        stub.calls.some(
          (c) =>
            c.url.includes("q=Miete") &&
            !c.url.includes("q=+Miete") &&
            c.url.includes("page=1")
        )
      ).toBe(true)
    })

    fireEvent.click(getByRole("button", { name: /Weiter/ }))
    await waitFor(() => {
      expect(stub.calls.some((c) => c.url.includes("page=2"))).toBe(true)
    })
  })

  it("follows the server's pageCount when the current page disappears", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/plans$/,
        json: { plans: [], total: 21, page: 1, pageCount: 2 },
        once: true,
      },
      {
        // e.g. the last plan on page 2 was just deleted — page 2 is gone
        url: /\/api\/plans$/,
        json: { plans: [], total: 20, page: 2, pageCount: 1 },
        once: true,
      },
      {
        url: /\/api\/plans$/,
        json: { plans: [], total: 20, page: 1, pageCount: 1 },
      },
    ])
    const { container, getByRole } = renderWithQuery(<PlansList />)

    await waitFor(() => {
      expect(container.textContent).toContain("21 Pläne")
    })

    fireEvent.click(getByRole("button", { name: /Weiter/ }))

    // the page-2 response reports pageCount 1 → re-request page 1 rather than
    // rendering a permanently empty page
    await waitFor(() => {
      const pages = stub.calls.map((c) =>
        new URL(c.url, "http://localhost").searchParams.get("page")
      )
      const pageTwo = pages.lastIndexOf("2")
      expect(pageTwo).toBeGreaterThan(-1)
      expect(pages.slice(pageTwo + 1)).toContain("1")
    })
  })

  it("keeps the current page when a create dialog is cancelled", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/plans$/,
        json: { ...ONE_PAGE, total: 21, pageCount: 2 },
      },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    const { getByRole, getByText, container } = renderWithQuery(<PlansList />)

    await waitFor(() => {
      expect(container.textContent).toContain("21 Pläne")
    })
    fireEvent.click(getByRole("button", { name: /Weiter/ }))
    await waitFor(() => {
      expect(stub.calls.some((c) => c.url.includes("page=2"))).toBe(true)
    })

    fireEvent.click(getByRole("button", { name: /Plan anlegen/ }))
    await waitFor(() => {
      expect(getByText("Anlegen")).toBeInTheDocument()
    })
    fireEvent.click(getByRole("button", { name: "Abbrechen" }))

    // cancelling is not a save: the table must not jump back to page 1
    await waitFor(() => {
      const pages = stub.calls.map((c) =>
        new URL(c.url, "http://localhost").searchParams.get("page")
      )
      const pageTwo = pages.lastIndexOf("2")
      expect(pageTwo).toBeGreaterThan(-1)
      expect(pages.slice(pageTwo + 1)).not.toContain("1")
    })
  })
})
