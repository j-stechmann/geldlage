// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { waitFor } from "@testing-library/react"
import { PlanDialog } from "@/components/planning/plan-dialog"
import { FilterBar } from "@/components/filter-bar"
import { EMPTY_FILTERS } from "@/lib/filters"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

beforeEach(() => {
  stubLocalStorage()
  ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
    vi.fn()
})

/**
 * Regression: the plan dialog once cached the WHOLE `{accounts: [...]}`
 * envelope under the shared ["accounts"] key while FilterBar expects the
 * bare array — after opening the dialog once, ANY FilterBar crashed with
 * "(accounts ?? []).reduce is not a function". Both consumers must agree
 * on the cache shape (bare array).
 */
describe("shared ['accounts'] cache shape (plan dialog ↔ FilterBar)", () => {
  it("FilterBar survives rendering AFTER the plan dialog fetched accounts", async () => {
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
      { url: /\/api\/labels$/, json: { labels: [] } },
      { url: /\/api\/categories$/, json: { categories: [] } },
    ])

    function Harness({ showBar }: { showBar: boolean }) {
      return (
        <>
          <PlanDialog open onOpenChange={() => {}} />
          {showBar && <FilterBar filters={EMPTY_FILTERS} onChange={() => {}} />}
        </>
      )
    }

    const { rerender, container, queryClient } = renderWithQuery(
      <Harness showBar={false} />
    )
    // the dialog fetched accounts + labels once
    await waitFor(() => {
      expect(stub.calls.filter((c) => c.url === "/api/accounts")).toHaveLength(
        1
      )
    })
    // THEN FilterBar mounts — same QueryClient, same ["accounts"] key
    rerender(<Harness showBar={true} />)
    await waitFor(() => {
      expect(container.textContent).toContain("Alle Konten")
    })
    // THE regression: the shared cache entry must stay the BARE ARRAY
    expect(Array.isArray(queryClient.getQueryData(["accounts"]))).toBe(true)
  })
})
