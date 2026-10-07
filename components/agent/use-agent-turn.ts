"use client"

import { useCallback, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  MESSAGES_KEY,
  THREADS_KEY,
  sendTurn,
} from "@/components/agent/agent-api"
import { parseAgentSse } from "@/components/agent/sse-events"
import type { ToolEvent } from "@/components/agent/types"

/**
 * Streaming turn state machine for the agent chat (ADR-0033): renders
 * optimistic UI while the SSE turn streams (polling is paused during the
 * turn, so the DB rows the server persisted are not visible until the
 * post-done refetch), absorbs aborts, and refetches the persisted rows
 * after done/error.
 *
 * The thread id is a `send` argument, not hook state: the first send may
 * create the thread (lazily), so a hook-level capture would be stale.
 */

export interface TurnStreams {
  content: string
  reasoning: string
  tools: ToolEvent[]
}

export function useAgentTurn() {
  const [streaming, setStreaming] = useState(false)
  const [streams, setStreams] = useState<TurnStreams>({
    content: "",
    reasoning: "",
    tools: [],
  })
  // The user message of the in-flight turn: rendered optimistically while
  // streaming (see module doc), replaced by the authoritative refetch.
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(
    null
  )
  const abortRef = useRef<AbortController | null>(null)
  const queryClient = useQueryClient()

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /**
   * Sends one user turn to the given thread. Resolves when the turn is
   * fully consumed (or aborted/failed) — the caller can refetch after
   * awaiting, though this hook already invalidates the queries in its
   * `finally`. Returns false when the send could not complete.
   */
  const send = useCallback(
    async (threadId: string, content: string): Promise<boolean> => {
      setPendingUserMessage(content)
      setStreaming(true)
      setStreams({ content: "", reasoning: "", tools: [] })
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const res = await sendTurn(threadId, content, controller.signal)
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as {
            message?: string
          } | null
          toast.error(body?.message ?? "Der Chat-Dienst ist nicht erreichbar.")
          return false
        }
        await consumeTurn(res.body)
        return true
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          toast.error("Die Verbindung zum LLM wurde unterbrochen.")
        }
        return false
      } finally {
        abortRef.current = null
        setStreaming(false)
        setPendingUserMessage(null)
        await queryClient
          .invalidateQueries({ queryKey: MESSAGES_KEY(threadId) })
          .catch(() => undefined)
        queryClient
          .invalidateQueries({ queryKey: THREADS_KEY })
          .catch(() => undefined)
      }
    },
    [queryClient]
  )

  return { streaming, streams, pendingUserMessage, send, stop }

  /** Streams the response body into state via the shared parser. */
  async function consumeTurn(body: ReadableStream<Uint8Array>): Promise<void> {
    for await (const ev of parseAgentSse(body)) {
      if (ev.type === "reasoning") {
        setStreams((s) => ({ ...s, reasoning: s.reasoning + ev.text }))
      } else if (ev.type === "delta") {
        setStreams((s) => ({ ...s, content: s.content + ev.text }))
      } else if (ev.type === "tool_call") {
        setStreams((s) => ({
          ...s,
          tools: [
            ...s.tools,
            { kind: "tool_call", name: ev.name, payload: ev.args },
          ],
        }))
      } else if (ev.type === "tool_result") {
        setStreams((s) => ({
          ...s,
          tools: [
            ...s.tools,
            { kind: "tool_result", name: ev.name, payload: ev.result },
          ],
        }))
      } else if (ev.type === "error") {
        toast.error(ev.message)
      }
      // done: the refetch in `finally` replaces the optimistic UI
    }
  }
}
