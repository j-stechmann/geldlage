import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const failure = vi.hoisted(() => ({
  resetInterruptedPredictionModels: vi.fn(() => {
    throw new Error("schema unavailable")
  }),
}))
vi.mock("@/lib/prediction/service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, ...failure }
})

import {
  predictionQueueSizeForTest,
  predictionSchedulerStartedForTest,
  predictionRetryTimerCountForTest,
  resetPredictionSchedulerForTest,
  scheduleRetryForTest,
  startPredictionScheduler,
} from "@/lib/prediction/scheduler"

describe("prediction scheduler guards", () => {
  beforeEach(() => {
    resetPredictionSchedulerForTest()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetPredictionSchedulerForTest()
  })

  it("logs a startup recovery failure instead of rejecting", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      expect(() => startPredictionScheduler()).not.toThrow()
      expect(console.error).toHaveBeenCalledWith(
        "[prediction] startup recovery failed:",
        expect.any(Error)
      )
      expect(predictionSchedulerStartedForTest()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("falls back to a 60 s wakeup for an invalid retryAt", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      scheduleRetryForTest(1, null, "not-a-date")
      expect(predictionRetryTimerCountForTest()).toBe(1)
      vi.advanceTimersByTime(59_000)
      expect(predictionRetryTimerCountForTest()).toBe(1)
      vi.advanceTimersByTime(2_000)
      expect(predictionRetryTimerCountForTest()).toBe(0)
      expect(predictionQueueSizeForTest()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
