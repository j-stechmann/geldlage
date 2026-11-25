// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest"
import { waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
}))

import DashboardPage from "@/app/page"
import type { PredictionForecast } from "@/lib/contracts/prediction"
import {
  renderWithQuery,
  stubFetch,
  stubLocalStorage,
  stubResizeObserver,
} from "./helpers-dom"

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

const OK_PREDICTION = {
  prediction: {
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2026-12-31", months: 2 },
    startingBalanceCents: 0,
    withoutSnapshot: true,
    monthly: [
      {
        month: "2026-10",
        partial: true,
        incomeCents: 0,
        expensesCents: 10_000,
        netCents: -10_000,
        bookedFuture: { incomeCents: 0, expensesCents: 0 },
        categories: [],
      },
      {
        month: "2026-11",
        partial: false,
        incomeCents: 0,
        expensesCents: 20_000,
        netCents: -20_000,
        bookedFuture: { incomeCents: 0, expensesCents: 0 },
        categories: [],
      },
    ],
    daily: [],
    projectedBalance: [{ date: "2026-10-27", balanceCents: 0 }],
    source: "baseline",
    pending: false,
    retryAt: null,
  },
} satisfies { prediction: PredictionForecast }

const OK_CATEGORIES = { categories: [] }
const OK_ACCOUNTS = { accounts: [] }

beforeEach(() => {
  stubLocalStorage()
  stubResizeObserver()
})

describe("dashboard always-on prediction", () => {
  it("fetches and overlays the two-month prediction without a toggle", async () => {
    const stub = stubFetch([
      { url: /\/api\/analytics/, json: OK_ANALYTICS },
      { url: /\/api\/categories$/, json: OK_CATEGORIES },
      { url: /\/api\/accounts$/, json: OK_ACCOUNTS },
      { url: /\/api\/predictions\/forecast/, json: OK_PREDICTION },
    ])
    const { container } = renderWithQuery(<DashboardPage />)

    await waitFor(() => {
      expect(container.textContent).toContain("Kontostand über Zeit")
    })
    expect(container.textContent).not.toContain("Geplant einblenden")
    expect(container.textContent).toContain("nächsten 2 Monate")
    await waitFor(() => {
      expect(
        stub.calls.filter((call) =>
          call.url.startsWith("/api/predictions/forecast")
        )
      ).toHaveLength(1)
    })
  })

  it("keeps the charts usable when the prediction request fails", async () => {
    stubFetch([
      { url: /\/api\/analytics/, json: OK_ANALYTICS },
      { url: /\/api\/categories$/, json: OK_CATEGORIES },
      { url: /\/api\/accounts$/, json: OK_ACCOUNTS },
      { url: /\/api\/predictions\/forecast/, status: 500 },
    ])
    const { container } = renderWithQuery(<DashboardPage />)
    await waitFor(() => {
      expect(container.textContent).toContain("Kontostand über Zeit")
      expect(container.textContent).toContain("Monatlicher Cashflow")
    })
    // prediction failure is deliberately not a dashboard error state; the
    // analytics charts remain available
    expect(container.textContent).not.toContain("Daten konnten nicht geladen")
  })
})
