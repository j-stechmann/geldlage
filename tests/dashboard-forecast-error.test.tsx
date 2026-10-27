// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
}))

import DashboardPage from "@/app/page"
import { useForecast } from "@/components/planning/api"
import {
  renderWithQuery,
  stubFetch,
  stubLocalStorage,
  stubResizeObserver,
} from "./helpers-dom"

/**
 * The dashboard's "Geplant einblenden" overlay must surface a failed
 * forecast read (/planung's ErrorState + retry pattern). A failed toggle
 * once rendered as charts silently without the overlay — visually
 * identical to "no plans exist".
 *
 * The forecast hook additionally re-keys on the account filter; it must
 * NOT serve cross-account placeholder data — the previous account's
 * projection figures must never flash briefly under another account.
 */

const OK_ANALYTICS = {
  kpis: {
    currentBalanceCents: 0,
    balanceWithoutSnapshot: true,
    avgMonthlyIncomeCents: null,
    avgMonthlyExpensesCents: null,
    savingsRate: null,
    transactionCount: 0,
    monthsCounted: 0,
  },
  monthlyCashflow: [],
  balanceTimeline: [],
  topCategories: [],
}

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

const OK_CATEGORIES = { categories: [] }
const OK_ACCOUNTS = { accounts: [] }

const ERROR_TEXT = "Daten konnten nicht geladen werden."

beforeEach(() => {
  stubLocalStorage()
  stubResizeObserver()
})

function toggleButton(): HTMLButtonElement {
  const btn = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Geplant einblenden"
  )
  expect(btn, "forecast toggle should be rendered").toBeTruthy()
  return btn as HTMLButtonElement
}

describe("dashboard forecast toggle failure surface", () => {
  it("a failed forecast read shows a retryable error instead of a silent no-overlay", async () => {
    const stub = stubFetch([
      { url: /\/api\/analytics/, json: OK_ANALYTICS },
      { url: /\/api\/categories$/, json: OK_CATEGORIES },
      { url: /\/api\/accounts$/, json: OK_ACCOUNTS },
      { url: /\/api\/plans\/forecast$/, status: 500 },
    ])
    const { container } = renderWithQuery(<DashboardPage />)
    await waitFor(() => {
      expect(container.textContent).toContain("Kontostand über Zeit")
    })

    // the toggle enables the forecast query — it must not fetch before
    expect(
      stub.calls.filter((c) => c.url.split("?")[0] === "/api/plans/forecast")
    ).toHaveLength(0)
    fireEvent.click(toggleButton())

    await waitFor(() => {
      expect(container.textContent).toContain(ERROR_TEXT)
    })
    // retry refetches the forecast endpoint
    const retry = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Erneut versuchen"
    ) as HTMLButtonElement
    fireEvent.click(retry)
    await waitFor(() => {
      expect(
        stub.calls.filter((c) => c.url.split("?")[0] === "/api/plans/forecast")
          .length
      ).toBeGreaterThanOrEqual(2)
    })
  })

  it("a successful forecast shows the projection line, no error state", async () => {
    const stub = stubFetch([
      { url: /\/api\/analytics/, json: OK_ANALYTICS },
      { url: /\/api\/categories$/, json: OK_CATEGORIES },
      { url: /\/api\/accounts$/, json: OK_ACCOUNTS },
      { url: /\/api\/plans\/forecast$/, json: OK_FORECAST },
    ])
    const { container } = renderWithQuery(<DashboardPage />)
    await waitFor(() => {
      expect(container.textContent).toContain("Kontostand über Zeit")
    })
    expect(container.textContent).not.toContain(ERROR_TEXT)
    fireEvent.click(toggleButton())
    await waitFor(() => {
      expect(container.textContent).toContain("Projektion")
    })
    expect(container.textContent).not.toContain(ERROR_TEXT)
    expect(
      stub.calls.filter((c) => c.url.split("?")[0] === "/api/plans/forecast")
    ).toHaveLength(1)
  })
})

describe("useForecast account switch (no cross-account placeholder)", () => {
  // distinguished by startingBalanceCents (all-accounts vs. account 1)
  const FORECAST_A = { ...OK_FORECAST.forecast, startingBalanceCents: 0 }
  const FORECAST_B = { ...OK_FORECAST.forecast, startingBalanceCents: 42_000 }

  function Probe({
    accountId,
    log,
  }: {
    accountId: number | null
    log: Array<unknown>
  }) {
    const query = useForecast(true, 12, accountId)
    log.push(query.data ?? null)
    return null
  }

  it("an account-filter switch never shows the previous account's projection while the new one loads", async () => {
    // FIFO script: the first forecast call (no accountId) serves A; the
    // re-keyed call (accountId=1) serves B
    const stub = stubFetch([
      {
        url: /\/api\/plans\/forecast$/,
        json: { forecast: FORECAST_A },
        once: true,
      },
      { url: /\/api\/plans\/forecast$/, json: { forecast: FORECAST_B } },
    ])
    const log: Array<unknown> = []
    const { rerender } = renderWithQuery(<Probe accountId={null} log={log} />)

    await waitFor(() => {
      expect(log.at(-1)).toEqual(FORECAST_A)
    })

    const switchIndex = log.length
    rerender(<Probe accountId={1} log={log} />)

    // the re-keyed query has no own data yet — every render between the
    // switch and B's arrival must carry NO projection (especially not A)
    await waitFor(() => {
      expect(log.at(-1)).toEqual(FORECAST_B)
    })
    expect(log.slice(switchIndex)).not.toContainEqual(FORECAST_A)
    // B really was fetched for the new account scope
    expect(
      stub.calls.some((c) => c.url.split("?")[1]?.includes("accountId=1"))
    ).toBe(true)
  })
})
