// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest"
import { waitFor } from "@testing-library/react"
import {
  PlanDialog,
  planFormFromPrefill,
} from "@/components/planning/plan-dialog"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

/**
 * Converting a booked transaction into a planned transaction pre-fills the
 * plan dialog from a PlanPrefill source: the amount sign drives the
 * direction, the source's day-of-month becomes a monthly BYMONTHDAY guess
 * (the dominant real-world shape: rent/salary/subscriptions repeat
 * monthly), and null account/category map to the dialog's "any"/"none"
 * sentinels. No linkage between plan and transaction is stored — plans
 * stay read-time matched against bookings.
 */

const EXPENSE_PREFILL = {
  counterparty: "Mietwerk GmbH",
  purpose: "Miete Januar",
  amountCents: -9950,
  dtstart: "2026-03-14",
  accountId: 7,
  categoryId: 3,
}

beforeEach(() => {
  stubLocalStorage()
  stubFetch([
    { url: /\/api\/accounts$/, json: { accounts: [] } },
    { url: /\/api\/labels$/, json: { labels: [] } },
  ])
})

// create mode labels the action button "Anlegen" (edit mode: "Speichern")
function createButton(): HTMLButtonElement {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent === "Anlegen"
  )
  expect(btn, "Anlegen button should be rendered").toBeTruthy()
  return btn as HTMLButtonElement
}

function inputByLabel(label: string): HTMLInputElement {
  const el = document.body.querySelector(
    `input[aria-label="${label}"]`
  ) as HTMLInputElement
  expect(el, `${label} input should be rendered`).toBeTruthy()
  return el
}

describe("planFormFromPrefill", () => {
  it("derives the direction from the amount sign and maps the fields", () => {
    const form = planFormFromPrefill(EXPENSE_PREFILL)
    expect(form.direction).toBe("Ausgang")
    expect(form.amountText).toBe("99,50")
    expect(form.counterparty).toBe("Mietwerk GmbH")
    expect(form.purpose).toBe("Miete Januar")
    expect(form.accountId).toBe("7")
    expect(form.categoryId).toBe("3")
    expect(form.dtstart).toBe("2026-03-14")
    expect(form.notes).toBe("")
  })

  it("a positive amount reads as Eingang", () => {
    const form = planFormFromPrefill({
      ...EXPENSE_PREFILL,
      amountCents: 123456,
    })
    expect(form.direction).toBe("Eingang")
    expect(form.amountText).toBe("1.234,56")
  })

  it("guesses a monthly rule on the booking's day-of-month", () => {
    const form = planFormFromPrefill(EXPENSE_PREFILL)
    expect(form.freq).toBe("MONTHLY")
    expect(form.monthlyMode).toBe("mday")
    expect(form.byMonthDayText).toBe("14")
    // builder-ownable rule: NOT routed to raw mode (rawDirty=false means an
    // untouched save stores the guessed monthly rule)
    expect(form.rawDirty).toBe(false)
  })

  it("null account/category map to the any/none sentinels", () => {
    const form = planFormFromPrefill({
      ...EXPENSE_PREFILL,
      accountId: null,
      categoryId: null,
    })
    expect(form.accountId).toBe("all")
    expect(form.categoryId).toBe("none")
  })

  it("a non-ISO source date keeps the one-off default instead of a broken rule", () => {
    const form = planFormFromPrefill({
      ...EXPENSE_PREFILL,
      dtstart: "14.03.2026",
    })
    expect(form.dtstart).toBe("")
    expect(form.freq).toBe("")
    expect(form.byMonthDayText).toBe("")
  })
})

describe("plan dialog pre-fill from a prefill source (render)", () => {
  it("shows the guessed monthly rule and stays saveable for day ≥ 29", async () => {
    // the 31st skips short months — the dialog hints that (same UX as a
    // hand-built monthly rule) instead of silently guessing a broken one
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        prefill={{
          counterparty: "Vermieter",
          purpose: null,
          amountCents: -95_000,
          dtstart: "2026-01-31",
          accountId: null,
          categoryId: null,
        }}
      />
    )
    const rruleInput = await waitFor(() => inputByLabel("RRULE"))
    expect(rruleInput.value).toBe("FREQ=MONTHLY;BYMONTHDAY=31")
    expect(inputByLabel("Betrag").value).toBe("950,00")
    expect(createButton()).toBeEnabled()
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "springt diese Regel über den 31."
      )
    })
  })

  it("an unparseable source date disarms save like an empty draft", async () => {
    renderWithQuery(
      <PlanDialog
        open
        onOpenChange={() => {}}
        prefill={{
          ...EXPENSE_PREFILL,
          dtstart: "not-a-date",
        }}
      />
    )
    await waitFor(() => expect(createButton()).toBeDisabled())
    expect(inputByLabel("Betrag").value).toBe("99,50")
  })
})
