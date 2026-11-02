// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, vi } from "vitest"
import { act, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/calendar",
}))

// The wrapper's job is chip → row lookup and dialog state; the real calendar
// and dialog only add noise here (their own suites cover them).
vi.mock("@/components/planning/plan-calendar", () => ({
  PlanCalendar: ({
    onEventClick,
  }: {
    onEventClick: (occurrence: { planId: string }) => void
  }) => (
    <button type="button" onClick={() => onEventClick({ planId: "plan-1" })}>
      chip
    </button>
  ),
}))

vi.mock("@/components/planning/plan-dialog", () => ({
  PlanDialog: ({
    open,
    plan,
  }: {
    open: boolean
    plan: { id: string } | null
  }) => (open ? <div>{plan ? `edit:${plan.id}` : "create"}</div> : null),
}))

import { PlanCalendarView } from "@/components/planning/plan-calendar-view"
import { PLANS_KEY } from "@/components/planning/api"
import { renderWithQuery, stubFetch } from "./helpers-dom"

const PLAN = {
  id: "plan-1",
  accountId: null,
  accountName: null,
  counterparty: "Mietwerk GmbH",
  purpose: null,
  amountCents: -9950,
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  dtstart: "2026-01-01",
  rrule: null,
  status: "active" as const,
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

function plansResponse(plans: unknown[]) {
  return { plans, total: plans.length, page: 1, pageCount: 1 }
}

describe("PlanCalendarView chip and create actions", () => {
  it("opens the edit dialog for a planned chip resolved from the plan list", async () => {
    const stub = stubFetch([
      { url: /\/api\/plans$/, json: plansResponse([PLAN]) },
    ])
    const { container, getByRole, queryClient } = renderWithQuery(
      <PlanCalendarView />
    )

    await waitFor(() => {
      expect(queryClient.getQueryState(PLANS_KEY)?.status).toBe("success")
    })
    fireEvent.click(getByRole("button", { name: "chip" }))

    await waitFor(() => {
      expect(container.textContent).toContain("edit:plan-1")
    })
    // the lookup asks the server to skip the per-plan next-date walk
    expect(stub.calls[0].url).toContain("includeNextDue=0")
  })

  it("refetches instead of leaving a dead chip when the plan is missing", async () => {
    const stub = stubFetch([{ url: /\/api\/plans$/, json: plansResponse([]) }])
    const { container, getByRole, queryClient } = renderWithQuery(
      <PlanCalendarView />
    )

    await waitFor(() => {
      expect(queryClient.getQueryState(PLANS_KEY)?.status).toBe("success")
    })
    expect(stub.calls.length).toBe(1)
    fireEvent.click(getByRole("button", { name: "chip" }))

    await waitFor(() => {
      expect(stub.calls.length).toBe(2)
    })
    expect(container.textContent).not.toContain("edit:")
  })

  it("refetches instead of opening a stale edit dialog after a failed refetch", async () => {
    const stub = stubFetch([
      { url: /\/api\/plans$/, json: plansResponse([PLAN]), once: true },
      { url: /\/api\/plans$/, status: 500 },
    ])
    const { container, getByRole, queryClient } = renderWithQuery(
      <PlanCalendarView />
    )
    await waitFor(() => {
      expect(queryClient.getQueryState(PLANS_KEY)?.status).toBe("success")
    })

    // a mutation-driven refetch fails; React Query keeps the last successful
    // rows, so the chip still resolves — but editing from that snapshot could
    // save outdated values
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: PLANS_KEY })
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(PLANS_KEY)?.status).toBe("error")
    })

    const before = stub.calls.length
    fireEvent.click(getByRole("button", { name: "chip" }))
    await waitFor(() => {
      expect(stub.calls.length).toBeGreaterThan(before)
    })
    expect(container.textContent).not.toContain("edit:")
  })

  it("offers plan creation from the calendar", async () => {
    stubFetch([{ url: /\/api\/plans$/, json: plansResponse([PLAN]) }])
    const { container, getByRole } = renderWithQuery(<PlanCalendarView />)

    fireEvent.click(getByRole("button", { name: /Plan anlegen/ }))

    await waitFor(() => {
      expect(container.textContent).toContain("create")
    })
  })
})
