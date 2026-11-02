// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, fireEvent, waitFor } from "@testing-library/react"
import { PlanDialog } from "@/components/planning/plan-dialog"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

/**
 * `onSaved(created)` is the callback the /plans list uses to jump back to
 * page 1 (and clear filters) after a create. It must fire exactly once, after
 * a successful save, with `true` for a create and `false` for an update — and
 * never on cancel/failure (the list would otherwise jump without a save).
 */

const PLAN = {
  id: "plan-1",
  accountId: null,
  accountName: null,
  counterparty: "Mietwerk GmbH",
  purpose: null,
  amountCents: -95_000,
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

const PREFILL = {
  counterparty: "Vermieter",
  purpose: null,
  amountCents: -95_000,
  dtstart: "2026-01-01",
  accountId: null,
  categoryId: null,
}

beforeEach(() => {
  stubLocalStorage()
})

function button(label: string): HTMLButtonElement {
  const el = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  )
  expect(el, `${label} button should be rendered`).toBeTruthy()
  return el as HTMLButtonElement
}

describe("PlanDialog onSaved", () => {
  it("reports a successful create with created=true", async () => {
    stubFetch([
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
      {
        url: /\/api\/plans$/,
        method: "POST",
        json: { plan: { ...PLAN, id: "plan-new" } },
      },
    ])
    const onSaved = vi.fn()
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
        prefill={PREFILL}
      />
    )

    const save = await waitFor(() => {
      const el = button("Anlegen")
      expect(el).toBeEnabled()
      return el
    })
    fireEvent.click(save)

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    expect(onSaved).toHaveBeenCalledWith(true)
  })

  it("reports a successful update with created=false", async () => {
    stubFetch([
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
      {
        url: /\/api\/plans\/plan-1$/,
        method: "PATCH",
        json: { plan: PLAN },
      },
    ])
    const onSaved = vi.fn()
    renderWithQuery(
      <PlanDialog open onOpenChange={() => {}} onSaved={onSaved} plan={PLAN} />
    )

    const save = await waitFor(() => {
      const el = button("Speichern")
      expect(el).toBeEnabled()
      return el
    })
    fireEvent.click(save)

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    expect(onSaved).toHaveBeenCalledWith(false)
  })

  it("does not report a failed create", async () => {
    const stub = stubFetch([
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
      {
        url: /\/api\/plans$/,
        method: "POST",
        status: 400,
        json: { error: "invalid_rrule" },
      },
    ])
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
        prefill={PREFILL}
      />
    )

    const save = await waitFor(() => {
      const el = button("Anlegen")
      expect(el).toBeEnabled()
      return el
    })
    fireEvent.click(save)

    await waitFor(() => {
      expect(
        stub.calls.some(
          (c) => c.url === "/api/plans" && c.init?.method === "POST"
        )
      ).toBe(true)
    })
    await act(async () => {})

    expect(onSaved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("does not report a cancelled dialog", async () => {
    stubFetch([
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
        prefill={PREFILL}
      />
    )

    await waitFor(() => expect(button("Abbrechen")).toBeEnabled())
    fireEvent.click(button("Abbrechen"))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSaved).not.toHaveBeenCalled()
  })
})
