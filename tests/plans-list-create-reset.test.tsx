// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, vi } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"

// The dialog's own save flow is covered elsewhere; this suite only needs the
// onSaved contract, so the mock stands in for a successful create.
vi.mock("@/components/planning/plan-dialog", () => ({
  PlanDialog: ({ onSaved }: { onSaved?: (created: boolean) => void }) => (
    <button type="button" onClick={() => onSaved?.(true)}>
      mock-save
    </button>
  ),
}))

import { PlansList } from "@/components/planning/plans-list"
import { renderWithQuery, stubFetch } from "./helpers-dom"

const PAGE = {
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
  total: 21,
  page: 1,
  pageCount: 2,
}

describe("PlansList create reset", () => {
  it("clears an active search after a successful create so the new plan is visible", async () => {
    const stub = stubFetch([{ url: /\/api\/plans$/, json: PAGE }])
    const { container, getByLabelText, getByRole } = renderWithQuery(
      <PlansList />
    )

    await waitFor(() => {
      expect(container.textContent).toContain("21 Pläne")
    })

    fireEvent.change(getByLabelText("Pläne durchsuchen"), {
      target: { value: "Miete" },
    })
    await waitFor(() => {
      expect(stub.calls.some((c) => c.url.includes("q=Miete"))).toBe(true)
    })

    const before = stub.calls.length
    fireEvent.click(getByRole("button", { name: "mock-save" }))

    // the newest plan sits on page 1 of the unfiltered list — a search that
    // does not match it would otherwise hide the create behind the toast only
    await waitFor(() => {
      expect(
        stub.calls
          .slice(before)
          .some((c) => c.url.includes("page=1") && !c.url.includes("q="))
      ).toBe(true)
    })
    expect(getByLabelText("Pläne durchsuchen")).toHaveValue("")
  })
})
