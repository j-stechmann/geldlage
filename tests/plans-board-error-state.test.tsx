// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"

const mockPush = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/planung",
}))

import { PlansBoard } from "@/components/planning/plans-board"
import {
  renderWithQuery,
  stubFetch,
  stubLocalStorage,
  stubResizeObserver,
} from "./helpers-dom"

/**
 * The /planung page must NOT render failed reads as silent empty states:
 * a failed plan list read as "Noch keine Pläne angelegt", a failed
 * forecast as an absent Prognose card, or failed calendar window reads as
 * an empty month all look identical to "nothing planned" — the same
 * ErrorState + retry pattern as the dashboard surfaces them instead.
 */

const OK_FORECAST = {
  forecast: {
    startingBalanceCents: 0,
    withoutSnapshot: true,
    today: "2026-10-26",
    horizon: { from: "2026-10-26", to: "2027-10-31" },
    monthlyPlanned: [],
    projectedBalance: [{ date: "2026-10-26", balanceCents: 0 }],
    plannedCategories: [],
  },
}
const OK_PLANS = { plans: [] }
const OK_OCC = { occurrences: [] }
const OK_CAL = { transactions: [] }

interface Fail {
  status: number
  json?: unknown
}

type StubbedFetch = ReturnType<typeof stubFetch>

function stubAll(fail: Record<string, Fail> = {}): StubbedFetch {
  return stubFetch([
    {
      url: /\/api\/plans$/,
      status: fail.plans?.status ?? 200,
      json: fail.plans?.json ?? OK_PLANS,
    },
    {
      url: /\/api\/plans\/occurrences$/,
      status: fail["occ"]?.status ?? 200,
      json: fail["occ"]?.json ?? OK_OCC,
    },
    {
      url: /\/api\/transactions\/calendar$/,
      status: fail["cal"]?.status ?? 200,
      json: fail["cal"]?.json ?? OK_CAL,
    },
    {
      url: /\/api\/plans\/forecast$/,
      status: fail.forecast?.status ?? 200,
      json: fail.forecast?.json ?? OK_FORECAST,
    },
  ])
}

const ERROR_TEXT = "Daten konnten nicht geladen werden."

/**
 * window_too_far is deterministic at a far distance (both window endpoints
 * refuse ±60 months of today; docs/planning.md), so the calendar must
 * answer with a navigation hint instead of the shared dead retry.
 */
const FAR_HINT = "Dieser Zeitraum liegt außerhalb des planbaren Fensters"
const FAR_ERROR = {
  status: 400,
  json: {
    error: "window_too_far",
    message: "window must lie within 1826 days of today",
  },
}

function retryButton(container: HTMLElement): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"))
  const retry = buttons.find((b) => b.textContent === "Erneut versuchen")
  expect(retry).toBeDefined()
  return retry as unknown as HTMLButtonElement
}

beforeEach(() => {
  stubLocalStorage()
  stubResizeObserver()
  mockPush.mockReset()
})

describe("PlansBoard failure surface", () => {
  it("failed plan list shows ErrorState, not the empty-state copy", async () => {
    stubAll({ plans: { status: 500 } })
    const { container } = renderWithQuery(<PlansBoard />)
    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    // the empty-state message would read as "nothing planned"
    expect(container.textContent).not.toContain("Noch keine Pläne")
  })

  it("failed forecast shows a retryable error card, not a hidden card", async () => {
    const stub = stubAll({ forecast: { status: 500 } })
    const { container } = renderWithQuery(<PlansBoard />)
    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    fireEvent.click(retryButton(container))
    await waitFor(() => {
      expect(
        stub.calls.filter((c) =>
          c.url.split("?")[0].endsWith("/api/plans/forecast")
        )
      ).toHaveLength(2)
    })
  })

  it("failed window reads show a calendar error banner; the board stays alive", async () => {
    stubAll({
      occ: { status: 500 },
      cal: { status: 500 },
    })
    const { container } = renderWithQuery(<PlansBoard />)
    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    // a generic failure keeps the retryable banner, not the far-window hint
    expect(container.textContent).not.toContain(FAR_HINT)
    // the calendar banner sits in a still-functional board (plans loaded)
    expect(container.textContent).toContain("Plan anlegen")
    expect(container.textContent).toContain("Noch keine Pläne")
  })

  it("a far window shows the navigation hint instead of a dead retry", async () => {
    stubAll({ occ: FAR_ERROR, cal: FAR_ERROR })
    const { container } = renderWithQuery(<PlansBoard />)
    await waitFor(() => {
      expect(container.textContent).toContain(FAR_HINT)
    })
    // the retry would 400 again at this distance (same window): absent
    const buttons = Array.from(container.querySelectorAll("button"))
    expect(buttons.some((b) => b.textContent === "Erneut versuchen")).toBe(
      false
    )
    // the hint must still read as failure — never as "nothing planned"
    expect(container.textContent).toContain("Plan anlegen")
  })
})
