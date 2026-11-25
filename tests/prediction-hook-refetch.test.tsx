// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { usePrediction } from "@/components/prediction/api"
import { stubFetch } from "./helpers-dom"

const PENDING = {
  prediction: {
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2026-12-31", months: 2 },
    startingBalanceCents: 0,
    withoutSnapshot: false,
    monthly: [],
    daily: [],
    projectedBalance: [],
    source: "baseline",
    pending: true,
    retryAt: null,
  },
}

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 } },
      })
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("usePrediction pending episode", () => {
  it("keeps polling after switching accounts mid-episode", async () => {
    const stub = stubFetch([
      { url: /\/api\/predictions\/forecast/, json: PENDING },
    ])
    const { rerender } = renderHook(
      ({ accountId }: { accountId: number | null }) => usePrediction(accountId),
      { wrapper: Wrapper, initialProps: { accountId: null as number | null } }
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    for (let i = 0; i < 61; i++) {
      await act(async () => {
        vi.advanceTimersByTime(2000)
        await Promise.resolve()
      })
    }
    rerender({ accountId: 1 })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const accountOneCalls = () =>
      stub.calls.filter((call) => call.url.includes("accountId=1")).length
    const afterSwitchInitial = accountOneCalls()
    expect(afterSwitchInitial).toBeGreaterThan(0)
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    expect(accountOneCalls()).toBeGreaterThan(afterSwitchInitial)
  })
})
