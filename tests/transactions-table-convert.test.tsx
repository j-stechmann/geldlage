// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"
import { TransactionsTable } from "@/components/transactions-table"
import { EMPTY_FILTERS } from "@/lib/filters"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"
import { PLANS_KEY, type PlanOccurrence } from "@/components/planning/api"

const ROW_A = {
  id: "tx-1",
  bookingDate: "2026-11-04",
  valueDate: null,
  status: "Gebucht",
  payer: "Max Mustermann",
  payee: "Mietwerk GmbH",
  purpose: "Miete",
  type: "Ausgang",
  counterpartyIban: "DE02120300000000202051",
  amountCents: -950_00,
  creditorId: null,
  mandateRef: null,
  customerRef: null,
  accountId: 1,
  accountName: "Girokonto",
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  labelStatus: "labeled",
}

const PLAN_ROW = {
  id: "plan-1",
  accountId: 1,
  accountName: "Girokonto",
  counterparty: "Mietwerk GmbH",
  purpose: "Miete",
  amountCents: -950_00,
  categoryId: null,
  categoryName: null,
  categoryColor: null,
  dtstart: "2026-10-04",
  rrule: "FREQ=MONTHLY;BYMONTHDAY=4",
  status: "active",
  notes: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
}

function matchedOccurrence(): PlanOccurrence {
  return {
    id: "plan-1::2026-11-04",
    planId: "plan-1",
    date: "2026-11-04",
    amountCents: -950_00,
    counterparty: "Mietwerk GmbH",
    purpose: "Miete",
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    accountId: 1,
    planStatus: "active",
    matched: {
      transactionId: "tx-1",
      bookingDate: "2026-11-04",
      amountCents: -950_00,
    },
  }
}

/**
 * The plan-affordance entry in the expanded detail row: unmatched rows
 * offer "In Planung umwandeln" (dialog pre-filled with the row's data and
 * the monthly day-of-month guess) and rows the read-time match already
 * claimed offer "Plan bearbeiten" for that plan instead — converting would
 * only duplicate it. While the ± posting-drift reverse lookup is still in
 * flight the button is disarmed.
 */
describe("TransactionsTable plan-affordance entry", () => {
  beforeEach(() => {
    stubLocalStorage()
    // jsdom has no scrollIntoView at all
    ;(Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
      vi.fn()
  })

  function renderTable() {
    return renderWithQuery(
      // focusTxId auto-expands the detail row (deep-link mode)
      <TransactionsTable filters={EMPTY_FILTERS} focusTxId="tx-1" />
    )
  }

  async function affordanceButton(label: string) {
    return await waitFor(() => {
      const btn = Array.from(document.body.querySelectorAll("button")).find(
        (b) => b.textContent?.includes(label)
      )
      expect(btn, `${label} button should be rendered`).toBeTruthy()
      return btn as HTMLButtonElement
    })
  }

  async function inputByLabel(label: string): Promise<HTMLInputElement> {
    return (await waitFor(() => {
      const el = document.body.querySelector(
        `input[aria-label="${label}"]`
      ) as HTMLInputElement | null
      expect(el, `${label} input should be rendered`).toBeTruthy()
      return el
    })) as HTMLInputElement
  }

  it("an unmatched row opens the plan dialog pre-filled from the transaction", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      // the ± posting-drift reverse lookup answers: no occurrence matches
      { url: /\/api\/plans\/occurrences$/, json: { occurrences: [] } },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    const convert = await affordanceButton("In Planung umwandeln")
    // disarmed while the reverse lookup resolves — wait for the armed state
    // so the click cannot fall through
    await waitFor(() => expect(convert.disabled).toBe(false))
    fireEvent.click(convert)

    // the dialog opens with the row's data pre-filled: payee of the
    // outgoing row as counterparty, German-formatted amount, the booking
    // day as a monthly BYMONTHDAY guess
    const counterparty = await inputByLabel("Vertragspartner")
    expect(counterparty.value).toBe("Mietwerk GmbH")
    expect((await inputByLabel("Betrag")).value).toBe("950,00")
    const rrule = await inputByLabel("RRULE")
    expect(rrule.value).toBe("FREQ=MONTHLY;BYMONTHDAY=4")
  })

  it("a matched row opens the matching plan's edit dialog instead", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      {
        url: /\/api\/plans\/occurrences$/,
        json: { occurrences: [matchedOccurrence()] },
      },
      { url: /\/api\/plans$/, json: { plans: [PLAN_ROW] } },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    const edit = await affordanceButton("Plan bearbeiten")
    await waitFor(() => expect(edit.disabled).toBe(false))
    // converting is gone for matched rows — no duplicate-plan path
    expect(
      Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("In Planung umwandeln")
      )
    ).toBeUndefined()
    fireEvent.click(edit)

    // EDIT mode ("Speichern", not "Anlegen") with the stored plan's data
    const save = await affordanceButton("Speichern")
    expect(save.textContent).toContain("Speichern")
    expect(
      Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Anlegen")
      )
    ).toBeUndefined()
    const counterparty = await inputByLabel("Vertragspartner")
    expect(counterparty.value).toBe("Mietwerk GmbH")
    expect((await inputByLabel("Betrag")).value).toBe("950,00")
    const rrule = await inputByLabel("RRULE")
    expect(rrule.value).toBe("FREQ=MONTHLY;BYMONTHDAY=4")
  })

  it("a failed reverse lookup falls back to the convert affordance", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      // e.g. window_too_far: the matching engine could not be consulted —
      // the affordance must not hide away (convert stays offered)
      { url: /\/api\/plans\/occurrences$/, json: {}, status: 400 },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    const convert = await affordanceButton("In Planung umwandeln")
    await waitFor(() => expect(convert.disabled).toBe(false))
    fireEvent.click(convert)
    await inputByLabel("Vertragspartner")
  })

  it("a failed plans read on a matched booking keeps convert disarmed", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: { rows: [ROW_A], total: 1, page: 1, pageCount: 1 },
      },
      // the occurrences lookup resolves the match, but the plan list the
      // edit affordance needs fails to load — the row must NOT read as
      // unmatched (offering convert would duplicate the plan): it stays
      // disarmed until a refetch resolves the plans query
      {
        url: /\/api\/plans\/occurrences$/,
        json: { occurrences: [matchedOccurrence()] },
      },
      { url: /\/api\/plans$/, json: {}, status: 500 },
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    const convert = await affordanceButton("In Planung umwandeln")
    await vi.waitFor(
      () => {
        // no edit target (plans failed) and convert never arms (matched)
        expect(convert.disabled).toBe(true)
        expect(
          Array.from(document.body.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("Plan bearbeiten")
          )
        ).toBeUndefined()
      },
      { timeout: 500, interval: 20 }
    )
  })

  it("a Nicht gebucht row carries no plan affordance — the engine pairs only Gebucht rows", async () => {
    stubFetch([
      {
        url: /\/api\/transactions$/,
        json: {
          rows: [{ ...ROW_A, status: "Nicht gebucht" }],
          total: 1,
          page: 1,
          pageCount: 1,
        },
      },
      // deliberately NO occurrences script: the reverse lookup must not
      // even fire for a pending row — stubFetch throws on any unscripted
      // call, and an unscripted call here MUST be a thrown-at-queryFn
      // bug rather than silently treated as "unmatched"
      { url: /\/api\/accounts$/, json: { accounts: [] } },
      { url: /\/api\/labels$/, json: { labels: [] } },
    ])
    renderTable()
    // the detail row renders (focus mode expands it)…
    await waitFor(() =>
      expect(document.body.textContent).toContain("Mietwerk GmbH")
    )
    // …yet stays free of both plan-affordance labels
    expect(
      Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("In Planung umwandeln")
      )
    ).toBeUndefined()
    expect(
      Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Plan bearbeiten")
      )
    ).toBeUndefined()
  })

  it("convert stays disarmed while a stale PLANS snapshot serves during its refetch", async () => {
    // replicate the app-cache race (staleTime 5s, refetchOnWindowFocus
    // false): a PLANS_KEY snapshot taken BEFORE the matching plan existed
    // renders instantly while the invalidated refetch runs — resolving
    // "unmatched" from it would arm a convert that duplicates the matching
    // plan. The plans refetch here never resolves, so the stale-serve
    // window is stretched for as long as this test asserts.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input).split("?")[0]
        if (path === "/api/plans") return new Promise<Response>(() => {})
        if (/\/api\/plans\/occurrences$/.test(path)) {
          return Response.json({ occurrences: [matchedOccurrence()] })
        }
        if (/\/api\/transactions$/.test(path)) {
          return Response.json({
            rows: [ROW_A],
            total: 1,
            page: 1,
            pageCount: 1,
          })
        }
        if (path === "/api/accounts") return Response.json({ accounts: [] })
        if (path === "/api/labels") return Response.json({ labels: [] })
        throw new TypeError(`fetch mocked out — no script for ${path}`)
      })
    )
    const { queryClient } = renderTable()
    // seed the stale snapshot synchronously after mount (no fetch resolved
    // yet): the plans observer only enables once the occurrences lookup
    // resolves, so the snapshot is in place before it can serve
    queryClient.setQueryData(PLANS_KEY, { plans: [] })
    const convert = await affordanceButton("In Planung umwandeln")
    // the button already renders disarmed while the lookup is in flight —
    // what must hold AFTER the occurrences resolved is that it NEVER arms
    // from the stale snapshot (the hung refetch = isFetching hold)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(convert.disabled).toBe(true)
    // no edit target either: the plan list the edit affordance needs
    // never resolves while the refetch hangs
    expect(
      Array.from(document.body.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Plan bearbeiten")
      )
    ).toBeUndefined()
  })
})
