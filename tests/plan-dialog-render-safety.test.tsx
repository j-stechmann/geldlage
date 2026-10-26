// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, beforeEach } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"
import { PlanDialog } from "@/components/planning/plan-dialog"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

/**
 * The effectiveRrule useMemo must NEVER throw: buildRrule (via
 * parseByMonthDay) throws on month-day garbage ("0", "45", letters,
 * duplicates) — and with no error.tsx boundary anywhere in app/, an
 * uncaught render error unmounts the entire app. The throw must become
 * inline preview text plus a disabled save instead.
 */

const BASE_PLAN = {
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
  status: "active" as const,
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

beforeEach(() => {
  stubLocalStorage()
  stubFetch([
    { url: /\/api\/accounts$/, json: { accounts: [] } },
    { url: /\/api\/labels$/, json: { labels: [] } },
  ])
})

function saveButton(): HTMLButtonElement {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent === "Speichern"
  )
  expect(btn, "Speichern button should be rendered").toBeTruthy()
  return btn as HTMLButtonElement
}

function inputByLabel(label: string): HTMLInputElement {
  const el = document.body.querySelector(
    `input[aria-label="${label}"]`
  ) as HTMLInputElement
  expect(el, `${label} input should be rendered`).toBeTruthy()
  return el
}

describe("plan dialog: invalid builder input must not crash the page", () => {
  it("monthly garbage shows the rule error and disables save instead of throwing", async () => {
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        }}
      />
    )
    const input = await waitFor(() => inputByLabel("Monatstage"))

    fireEvent.change(input, { target: { value: "0" } })
    // the tree is still alive here — the queries below would fail on an
    // unmounted app; the error text surfaces in the preview box, save is
    // disarmed
    await waitFor(() => {
      expect(document.body.textContent).toContain("Ungültige Monatstage")
    })
    expect(saveButton()).toBeDisabled()

    // repairing the input clears the error and re-enables the dialog
    fireEvent.change(input, { target: { value: "1, 15" } })
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Ungültige Monatstage")
    })
    expect(saveButton()).toBeEnabled()
  })

  it("yearly garbage in the Tag field is contained the same way", async () => {
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        plan={{
          ...BASE_PLAN,
          rrule: "FREQ=YEARLY;BYMONTHDAY=1",
        }}
      />
    )
    const input = await waitFor(() => inputByLabel("Tag im Monat"))

    fireEvent.change(input, { target: { value: "45" } })
    await waitFor(() => {
      expect(document.body.textContent).toContain("Ungültige Monatstage")
    })
    expect(saveButton()).toBeDisabled()
  })
})
