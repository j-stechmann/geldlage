"use client"

import { useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api-fetch"
import type { PredictionForecast } from "@/lib/contracts/prediction"

/** Two-phase key: the account filter scopes the model exactly. */
export function predictionKey(accountId: number | null) {
  return ["prediction", accountId ?? "all"] as const
}

/**
 * The chart prediction. Fetched unconditionally — there is no toggle and no
 * training UI. A missing model still returns the daily baseline, so this
 * query normally succeeds even for a brand-new account.
 *
 * No `placeholderData`: switching the account filter must never flash the
 * previous account's concrete money figures.
 */
/** Pure polling interval for tests and the hook. */
export function predictionRefetchInterval(
  data: PredictionForecast | undefined,
  now: number = Date.now(),
  pendingPolls = 0
): number | false {
  if (!data?.pending || pendingPolls > 60) return false
  if (data.retryAt) {
    const retry = Date.parse(data.retryAt)
    if (!Number.isFinite(retry)) return 2000
    const delay = retry - now + 1000
    return Math.min(Math.max(2000, delay), 60 * 60_000)
  }
  return 2000
}

/**
 * Tracks a pending episode per query key. `polls` is the number of completed
 * data updates since the episode started (not every refetchInterval
 * evaluation), and the state resets when the key changes or pending ends.
 */
export function pendingPollState(
  previous: { key: string; wasPending: boolean; startCount: number },
  key: string,
  pending: boolean,
  dataUpdateCount: number
): { key: string; wasPending: boolean; startCount: number; polls: number } {
  if (previous.key !== key) {
    return {
      key,
      wasPending: pending,
      startCount: dataUpdateCount,
      polls: 0,
    }
  }
  if (!pending) {
    return { key, wasPending: false, startCount: dataUpdateCount, polls: 0 }
  }
  const startCount = previous.wasPending ? previous.startCount : dataUpdateCount
  return {
    key,
    wasPending: true,
    startCount,
    polls: dataUpdateCount - startCount,
  }
}

export function usePrediction(accountId: number | null) {
  const episode = useRef({
    key: predictionKey(accountId).join(":"),
    wasPending: false,
    startCount: 0,
  })
  return useQuery<PredictionForecast>({
    queryKey: predictionKey(accountId),
    queryFn: async () => {
      const sp = new URLSearchParams()
      if (accountId !== null) sp.set("accountId", String(accountId))
      const res = await apiFetch(`/api/predictions/forecast?${sp.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()).prediction as PredictionForecast
    },
    // A pending response means the automatic model is training or stale.
    // While a model is training every 2 s; during failure backoff wait for
    // retryAt (capped at one hour) so the refreshed overlay appears without a
    // manual reload.
    refetchInterval: (query) => {
      const data = query.state.data
      const next = pendingPollState(
        episode.current,
        predictionKey(accountId).join(":"),
        data?.pending === true,
        query.state.dataUpdateCount
      )
      episode.current = next
      return predictionRefetchInterval(data, Date.now(), next.polls)
    },
  })
}
