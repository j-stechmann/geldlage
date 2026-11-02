// @vitest-environment jsdom
import React from "react"
import { afterEach, describe, it, expect, vi } from "vitest"
import { act, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlansList } from "@/components/planning/plans-list"
import { resolveCategoryColor } from "@/lib/category-colors"
import { renderWithQuery, stubFetch } from "./helpers-dom"

// the settling test installs a manual fetch stub; do not leak it into a later
// test in this file (each one installs its own, but the cleanup keeps that
// invariant explicit)
afterEach(() => vi.unstubAllGlobals())

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
    const { container, getByRole, queryClient } = renderWithQuery(<PlansList />)
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
    // …and its actions are disarmed: acting on a row the failed refetch could
    // not confirm (deleted/changed elsewhere) would target stale state
    expect(
      getByRole("button", { name: "Aktionen für Mietwerk GmbH" })
    ).toBeDisabled()
  })

  it("disarms actions and hides the stale count while a page is still loading", async () => {
    // a manual fetch stub so the page-2 response can be held open
    const calls: string[] = []
    let resolvePageTwo: (res: Response) => void = () => {}
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        if (url.includes("page=2")) {
          return new Promise<Response>((resolve) => {
            resolvePageTwo = resolve
          })
        }
        return Promise.resolve(
          response({ ...ONE_PAGE, total: 41, pageCount: 3 })
        )
      })
    )

    const { container, getByRole } = renderWithQuery(<PlansList />)
    await waitFor(() => {
      expect(container.textContent).toContain("41 Pläne")
    })

    fireEvent.click(getByRole("button", { name: /Weiter/ }))
    await waitFor(() => {
      expect(calls.some((u) => u.includes("page=2"))).toBe(true)
    })

    // placeholder rows are readable but not actionable, and the previous
    // query's total/pageCount must not be presented as the current answer
    expect(
      getByRole("button", { name: "Aktionen für Mietwerk GmbH" })
    ).toBeDisabled()
    expect(container.textContent).not.toContain("41 Pläne")
    expect(container.textContent).toContain("2 / …")
    expect(container.textContent).toContain("…")

    await act(async () => {
      resolvePageTwo(
        response({
          ...ONE_PAGE,
          page: 2,
          total: 41,
          pageCount: 3,
        })
      )
    })
    await waitFor(() => {
      expect(container.textContent).toContain("2 / 3")
    })
    expect(
      getByRole("button", { name: "Aktionen für Mietwerk GmbH" })
    ).toBeEnabled()
  })

  it("renders a category badge even when the stored color is missing", async () => {
    // legacy/imported rows can carry a category name with a NULL color;
    // resolveCategoryColor() derives a palette color from the id, so the
    // name must still render instead of falling back to "—"
    stubFetch([
      {
        url: /\/api\/plans$/,
        json: {
          ...ONE_PAGE,
          plans: [
            {
              ...ONE_PAGE.plans[0],
              categoryId: 7,
              categoryName: "Nebenkosten",
              categoryColor: null,
            },
          ],
        },
      },
    ])
    const { container } = renderWithQuery(<PlansList />)
    await waitFor(() => {
      expect(container.textContent).toContain("Nebenkosten")
    })
    // the badge keeps the palette fallback driven by the category id
    const badge = container.querySelector(".category-badge") as HTMLElement
    expect(badge).toBeTruthy()
    expect(badge.style.getPropertyValue("--category-color")).toBe(
      resolveCategoryColor(7, null)
    )
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
    const { getByLabelText, getByRole, container } = renderWithQuery(
      <PlansList />
    )

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
    // wait out the placeholder transition so the pager is armed again
    await waitFor(() => {
      expect(container.textContent).toContain("1 / 2")
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

  it("returns to page 1 when the filter changes while browsing a later page", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/plans$/,
        json: { ...ONE_PAGE, total: 41, pageCount: 3 },
      },
    ])
    const { getByLabelText, getByRole, container } = renderWithQuery(
      <PlansList />
    )
    await waitFor(() => {
      expect(container.textContent).toContain("41 Pläne")
    })

    fireEvent.click(getByRole("button", { name: /Weiter/ }))
    await waitFor(() => {
      expect(stub.calls.some((c) => c.url.includes("page=2"))).toBe(true)
    })

    fireEvent.change(getByLabelText("Pläne durchsuchen"), {
      target: { value: "Miete" },
    })
    await waitFor(() => {
      const last = stub.calls[stub.calls.length - 1]
      expect(last.url).toContain("q=Miete")
      expect(last.url).toContain("page=1")
    })
  })

  it("the reset button clears search/status and returns to page 1 immediately", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/plans$/,
        json: { ...ONE_PAGE, total: 41, pageCount: 3 },
      },
    ])
    const { getByLabelText, getByRole, container } = renderWithQuery(
      <PlansList />
    )
    await waitFor(() => {
      expect(container.textContent).toContain("41 Pläne")
    })

    fireEvent.click(getByRole("button", { name: /Weiter/ }))
    await waitFor(() => {
      expect(stub.calls.some((c) => c.url.includes("page=2"))).toBe(true)
    })
    fireEvent.change(getByLabelText("Pläne durchsuchen"), {
      target: { value: "Miete" },
    })
    await waitFor(() => {
      expect(stub.calls.some((c) => c.url.includes("q=Miete"))).toBe(true)
    })

    fireEvent.click(
      getByRole("button", { name: "Suche und Filter zurücksetzen" })
    )

    // the applied filter and page drop without waiting for the 300 ms
    // debounce: the empty input and the results cannot disagree
    await waitFor(() => {
      const last = stub.calls[stub.calls.length - 1]
      expect(last.url).not.toContain("q=")
      expect(last.url).not.toContain("status=")
      expect(last.url).toContain("page=1")
    })
    expect(
      (getByLabelText("Pläne durchsuchen") as HTMLInputElement).value
    ).toBe("")
    expect(container.textContent).toContain("41 Pläne")
  })

  it("reset returns an unfiltered later page to page 1", async () => {
    const stub = stubFetch([
      {
        url: /\/api\/plans$/,
        json: { ...ONE_PAGE, total: 41, pageCount: 3 },
      },
    ])
    const { container, getByRole } = renderWithQuery(<PlansList />)
    await waitFor(() => {
      expect(container.textContent).toContain("41 Pläne")
    })

    fireEvent.click(getByRole("button", { name: /Weiter/ }))
    await waitFor(() => {
      expect(stub.calls.some((c) => c.url.includes("page=2"))).toBe(true)
    })

    // no search/status is active, so only the explicit setPage(1) can bring
    // the list back — the pre-fix handler left the user on page 2
    fireEvent.click(
      getByRole("button", { name: "Suche und Filter zurücksetzen" })
    )
    await waitFor(() => {
      const last = stub.calls[stub.calls.length - 1]
      expect(last.url).toContain("page=1")
      expect(last.url).not.toContain("q=")
      expect(last.url).not.toContain("status=")
    })
  })

  it("serializes the status filter and clears it on reset", async () => {
    const stub = stubFetch([
      { url: /\/api\/plans$/, json: { ...ONE_PAGE, total: 1 } },
    ])
    const { getByRole, container } = renderWithQuery(<PlansList />)
    await waitFor(() => {
      expect(container.textContent).toContain("1 Plan")
    })

    const user = userEvent.setup()
    await user.click(getByRole("combobox", { name: "Status filtern" }))
    const active = await waitFor(() => getByRole("option", { name: "Aktiv" }))
    await user.click(active)

    await waitFor(() => {
      const statusCall = stub.calls.find((c) => c.url.includes("status=active"))
      expect(statusCall).toBeTruthy()
      expect(statusCall!.url).toContain("page=1")
    })

    await user.click(
      getByRole("button", { name: "Suche und Filter zurücksetzen" })
    )
    await waitFor(() => {
      const last = stub.calls[stub.calls.length - 1]
      expect(last.url).not.toContain("status=")
      expect(last.url).toContain("page=1")
    })
  })
})
