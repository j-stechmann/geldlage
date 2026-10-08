"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  MESSAGES_KEY,
  THREADS_KEY,
  createThread as apiCreateThread,
  fetchThreads,
  fetchThreadDetail,
  invalidate,
} from "@/components/agent/agent-api"
import type { ThreadSummary } from "@/components/agent/types"
import { toast } from "sonner"

/**
 * Thread registry state for the agent chat (ADR-0033): the threads list
 * query (polling), the per-thread detail query (polling, paused while a
 * turn streams in), the active-thread derivation with localStorage
 * persistence, and thread creation.
 */

const ACTIVE_THREAD_KEY = "geldlage.agent.thread"

/**
 * "stored" = what the user last selected; the effective id derives from it
 * plus the threads list (a vanished thread ⇒ nothing — the view resets).
 */
function readStoredThreadId(): string {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(ACTIVE_THREAD_KEY) ?? ""
}

export function useAgentThreads(streaming: boolean) {
  const [storedThreadId, setActiveThreadId] = useState(readStoredThreadId)
  const queryClient = useQueryClient()

  const threadsQuery = useQuery<{ threads: ThreadSummary[] }>({
    queryKey: THREADS_KEY,
    queryFn: fetchThreads,
    refetchInterval: 15_000,
  })

  // The derived effective id: a stored id whose thread vanished (owner
  // deleted / membership revoked) yields "" — the view resets and the next
  // send lazily creates a fresh thread.
  const threads = useMemo(
    () => threadsQuery.data?.threads ?? [],
    [threadsQuery.data]
  )
  const storedThreadExists = threads.some((t) => t.id === storedThreadId)
  const newestOwnId = useMemo(() => {
    for (const t of threads) if (t.role === "owner") return t.id
    return ""
  }, [threads])
  const activeThreadId =
    storedThreadId === "" || storedThreadExists
      ? storedThreadId || newestOwnId
      : ""

  const detailQuery = useQuery({
    queryKey: MESSAGES_KEY(activeThreadId),
    enabled: Boolean(activeThreadId) && Boolean(threadsQuery.data),
    queryFn: () => fetchThreadDetail(activeThreadId),
    refetchInterval: streaming ? false : 4_000,
    retry: false,
  })

  const activeThread = threads.find((t) => t.id === activeThreadId)

  useEffect(() => {
    if (threadsQuery.data) {
      window.localStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId)
    }
  }, [activeThreadId, threadsQuery.data])

  const createThread = useCallback(async (): Promise<string | null> => {
    const thread = await apiCreateThread()
    if (!thread) {
      toast.error("Neuer Chat konnte nicht erstellt werden.")
      return null
    }
    await queryClient.invalidateQueries({ queryKey: THREADS_KEY })
    setActiveThreadId(thread.id)
    return thread.id
  }, [queryClient])

  /** After any thread mutation: refresh lists (and optionally messages). */
  const refresh = useCallback(
    (threadId?: string) => {
      invalidate(queryClient, threadId)
    },
    [queryClient]
  )

  return {
    threadsQuery,
    detailQuery,
    threads,
    activeThreadId,
    activeThread,
    setActiveThreadId,
    createThread,
    refresh,
  }
}
