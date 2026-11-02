// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/calendar",
}))

import { PlanCalendarView } from "@/components/planning/plan-calendar-view"
import {
  renderWithQuery,
  stubFetch,
  stubLocalStorage,
  stubResizeObserver,
} from "./helpers-dom"

/**
 * /calendar owns its plan-edit dialog, but its window reads (occurrences +
 * booked bank rows) must keep the board's failure semantics: a failed read
 * is never an empty month, and a window beyond the planning range answers
 * with a navigation hint instead of a retry that can never succeed.
 */

const OK_PLANS = { plans: [], total: 0, page: 1, pageCount: 1 }
const OK_OCC = { occurrences: [] }
const OK_CAL = { transactions: [] }

const ERROR_TEXT = "Daten konnten nicht geladen werden."
const FAR_HINT = "Dieser Zeitraum liegt außerhalb des planbaren Fensters"
const FAR_ERROR = {
  status: 400,
  json: {
    error: "window_too_far",
    message: "window must lie within 1826 days of today",
  },
}

function stubAll(
  fail: Record<string, { status: number; json?: unknown }> = {}
) {
  return stubFetch([
    {
      url: /\/api\/plans$/,
      status: fail.plans?.status ?? 200,
      json: fail.plans?.json ?? OK_PLANS,
    },
    {
      url: /\/api\/plans\/occurrences$/,
      status: fail.occ?.status ?? 200,
      json: fail.occ?.json ?? OK_OCC,
    },
    {
      url: /\/api\/transactions\/calendar$/,
      status: fail.cal?.status ?? 200,
      json: fail.cal?.json ?? OK_CAL,
    },
  ])
}

beforeEach(() => {
  stubLocalStorage()
  stubResizeObserver()
})

describe("PlanCalendarView failure surface", () => {
  it("a failed window read shows the retryable banner, not an empty month", async () => {
    stubAll({ occ: { status: 500 }, cal: { status: 500 } })
    const { container } = renderWithQuery(<PlanCalendarView />)
    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    expect(container.textContent).not.toContain(FAR_HINT)
  })

  it("a far window shows the navigation hint without a dead retry", async () => {
    stubAll({ occ: FAR_ERROR, cal: FAR_ERROR })
    const { container } = renderWithQuery(<PlanCalendarView />)
    await waitFor(() => {
      expect(container.textContent).toContain(FAR_HINT)
    })
    const buttons = Array.from(container.querySelectorAll("button"))
    expect(buttons.some((b) => b.textContent === "Erneut versuchen")).toBe(
      false
    )
  })

  it("a failed plan-list read keeps the calendar alive and offers a retry", async () => {
    stubAll({ plans: { status: 500 } })
    const { container } = renderWithQuery(<PlanCalendarView />)
    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    // the calendar itself still mounts (its own reads succeeded)
    expect(container.textContent).toContain("Monat")
  })
})
