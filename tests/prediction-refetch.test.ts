import { describe, it, expect } from "vitest"
import {
  pendingPollState,
  predictionRefetchInterval,
} from "@/components/prediction/api"
import {
  predictionMonthsLabel,
  type PredictionForecast,
} from "@/lib/contracts/prediction"

function forecast(over: Partial<PredictionForecast> = {}): PredictionForecast {
  return {
    today: "2026-10-27",
    horizon: { from: "2026-10-27", to: "2026-12-31", months: 2 },
    startingBalanceCents: 0,
    withoutSnapshot: false,
    monthly: [],
    daily: [],
    projectedBalance: [],
    source: "baseline",
    pending: false,
    retryAt: null,
    ...over,
  }
}

describe("prediction copy", () => {
  it("pluralizes the shared month label", () => {
    expect(predictionMonthsLabel(1)).toBe("Monat")
    expect(predictionMonthsLabel(2)).toBe("Monate")
  })
})

describe("pending poll episode", () => {
  it("anchors the update count at the episode start and resets after it", () => {
    const start = pendingPollState(
      { key: "k", wasPending: false, startCount: 0 },
      "k",
      true,
      7
    )
    expect(start).toEqual({
      key: "k",
      wasPending: true,
      startCount: 7,
      polls: 0,
    })
    expect(pendingPollState(start, "k", true, 9)).toEqual({
      key: "k",
      wasPending: true,
      startCount: 7,
      polls: 2,
    })
    expect(pendingPollState(start, "k", false, 10)).toEqual({
      key: "k",
      wasPending: false,
      startCount: 10,
      polls: 0,
    })
  })

  it("resets the episode when the account key changes", () => {
    expect(
      pendingPollState(
        { key: "account:1", wasPending: true, startCount: 5 },
        "account:2",
        true,
        8
      )
    ).toEqual({
      key: "account:2",
      wasPending: true,
      startCount: 8,
      polls: 0,
    })
  })
})

describe("prediction refetch interval", () => {
  it("does not poll when not pending", () => {
    expect(predictionRefetchInterval(undefined)).toBe(false)
    expect(predictionRefetchInterval(forecast())).toBe(false)
  })

  it("polls every 2 s while a pending model trains", () => {
    expect(predictionRefetchInterval(forecast({ pending: true }))).toBe(2000)
  })

  it("waits for the backoff retry instant", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z")
    expect(
      predictionRefetchInterval(
        forecast({
          pending: true,
          retryAt: "2026-10-27T12:01:00.000Z",
        }),
        now
      )
    ).toBe(61_000)
  })

  it("polls immediately once the retry instant has passed", () => {
    const now = Date.parse("2026-10-27T12:02:00.000Z")
    expect(
      predictionRefetchInterval(
        forecast({
          pending: true,
          retryAt: "2026-10-27T12:01:00.000Z",
        }),
        now
      )
    ).toBe(2000)
  })

  it("does not poll forever on a permanently pending scope", () => {
    expect(
      predictionRefetchInterval(
        forecast({ pending: true }),
        Date.parse("2026-10-27T12:00:00.000Z"),
        61
      )
    ).toBe(false)
  })

  it("handles an invalid retryAt without NaN", () => {
    expect(
      predictionRefetchInterval(
        forecast({ pending: true, retryAt: "not-a-date" }),
        Date.parse("2026-10-27T12:00:00.000Z")
      )
    ).toBe(2000)
  })

  it("caps a far-future retry at one hour", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z")
    expect(
      predictionRefetchInterval(
        forecast({
          pending: true,
          retryAt: "2026-10-28T12:00:00.000Z",
        }),
        now
      )
    ).toBe(60 * 60_000)
  })
})
