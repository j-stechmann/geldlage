"use client"

import { useCallback, useEffect, useRef, useState } from "react"
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
 * after done/error. Unmounting the owning component (e.g. closing the
 * dock) aborts the in-flight request — same semantic as the Stop button.
 * `turnThreadId` reports the thread the in-flight turn
 * belongs to so callers scope the turn UI to it — the thread dropdown
 * stays usable mid-turn, and other threads' lists must not absorb the
 * optimistic bubble or the live stream.
 *
 * Claude Code-style live transcript: each `round` frame freezes the
 * streamed prose/reasoning into its own segment, so multi-round turns
 * render one bubble per round with the tool chips attached to the round
 * that called them — mirroring the per-round rows the server persists.
 * The post-done refetch replaces segments with the authoritative rows.
 *
 * The thread id is a `send` argument, not hook state: the first send may
 * create the thread (lazily), so a hook-level capture would be stale. It
 * is only mirrored into state for the turn-UI scoping above.
 */

/** One round's stream state: prose + reasoning trace + executed tools. */
export interface TurnSegment {
  content: string
  reasoning: string
  tools: ToolEvent[]
}

export interface TurnStreams {
  /** Completed rounds, oldest first (frozen by `round` frames). */
  segments: TurnSegment[]
  /** The round currently streaming (empty while its tools execute). */
  current: TurnSegment
}

const EMPTY_SEGMENT: TurnSegment = { content: "", reasoning: "", tools: [] }

export function useAgentTurn() {
  const [streaming, setStreaming] = useState(false)
  const [streams, setStreams] = useState<TurnStreams>({
    segments: [],
    current: EMPTY_SEGMENT,
  })
  // The user message of the in-flight turn: rendered optimistically while
  // streaming (see module doc), replaced by the authoritative refetch. The
  // route echoes the persisted row's id in its first `user` frame — once
  // aligned, the list can dedupe that row against this bubble (the detail
  // fetch races a first-turn send: the lazily created thread enables the
  // query right after the server persisted the row).
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(
    null
  )
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null)
  // The thread the in-flight turn belongs to (set with the pending state,
  // cleared with it in `finally`): the list renders turn UI only while
  // viewing this thread.
  const [turnThreadId, setTurnThreadId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const queryClient = useQueryClient()

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // Closing the dock unmounts AgentChat; without this the fetch keeps
  // streaming into dead state and the LLM slot burns to completion.
  // The post-abort `finally` still invalidates, so reopening shows
  // whatever the server managed to persist before the signal fired.
  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  /**
   * Sends one user turn to the given thread. Resolves `true` once the
   * server accepted the turn — from that moment the user message row is
   * persisted (stream failures and aborts are surfaced here via toasts
   * and the post-turn refetch), so callers must NOT put the content back
   * into the composer: a retry would append a duplicate. Resolves `false`
   * only when the request was rejected before any persistence (HTTP
   * error, unreachable server) — callers may then restore the typed
   * content for a retry.
   */
  const send = useCallback(
    async (threadId: string, content: string): Promise<boolean> => {
      setPendingUserMessage(content)
      setPendingMessageId(null)
      setTurnThreadId(threadId)
      setStreaming(true)
      setStreams({ segments: [], current: EMPTY_SEGMENT })
      const controller = new AbortController()
      abortRef.current = controller
      try {
        let res: Response
        try {
          res = await sendTurn(threadId, content, controller.signal)
        } catch (err) {
          // Aborted before headers: the server may already have persisted
          // the user row — treat as accepted (restoring the composer
          // would invite a duplicate resend).
          if (err instanceof DOMException && err.name === "AbortError") {
            return true
          }
          toast.error("Der Chat-Dienst ist nicht erreichbar.")
          return false
        }
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as {
            message?: string
          } | null
          // A 404 is the thread routes' {error: "not_found"}: the thread
          // was deleted (or access revoked) mid-session — its body has
          // no message field, and the generic fallback would misleadingly
          // claim the service is down. The finally-refetch below aligns
          // the view with the gone thread.
          toast.error(
            body?.message ??
              (res.status === 404
                ? "Dieser Chat existiert nicht mehr."
                : "Der Chat-Dienst ist nicht erreichbar.")
          )
          return false
        }
        // Accepted: everything from here on (mid-stream connection loss,
        // aborts) still had the user row persisted — failures surface via
        // toasts below and the refetch, never by restoring the composer.
        try {
          await consumeTurn(res.body)
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            toast.error("Die Verbindung zum LLM wurde unterbrochen.")
          }
        }
        return true
      } finally {
        abortRef.current = null
        // Invalidate BEFORE dropping the optimistic state: the awaited
        // refetch (the streaming detail query pauses while streaming, so
        // this is the fresh view) lands in the cache first, then the
        // pending bubble unmounts in the same commit the persisted rows
        // appear — never a flash of a missing user message.
        await queryClient
          .invalidateQueries({ queryKey: MESSAGES_KEY(threadId) })
          .catch(() => undefined)
        queryClient
          .invalidateQueries({ queryKey: THREADS_KEY })
          .catch(() => undefined)
        setPendingMessageId(null)
        setPendingUserMessage(null)
        setTurnThreadId(null)
        setStreaming(false)
      }
    },
    [queryClient]
  )

  return {
    streaming,
    streams,
    pendingUserMessage,
    pendingMessageId,
    turnThreadId,
    send,
    stop,
  }

  /** Streams the response body into state via the shared parser. */
  async function consumeTurn(body: ReadableStream<Uint8Array>): Promise<void> {
    for await (const ev of parseAgentSse(body)) {
      if (ev.type === "user") {
        if (ev.id) setPendingMessageId(ev.id)
      } else if (ev.type === "round") {
        // Freeze the streamed round as its own segment; the server
        // persists one assistant row per round the same way.
        setStreams((s) => ({
          segments: [...s.segments, s.current],
          current: EMPTY_SEGMENT,
        }))
      } else if (ev.type === "reasoning") {
        setStreams((s) => ({
          ...s,
          current: { ...s.current, reasoning: s.current.reasoning + ev.text },
        }))
      } else if (ev.type === "delta") {
        setStreams((s) => ({
          ...s,
          current: { ...s.current, content: s.current.content + ev.text },
        }))
      } else if (ev.type === "tool_call") {
        setStreams((s) =>
          appendTool(s, { kind: "tool_call", name: ev.name, payload: ev.args })
        )
      } else if (ev.type === "tool_result") {
        setStreams((s) =>
          appendTool(s, {
            kind: "tool_result",
            name: ev.name,
            payload: ev.result,
          })
        )
      } else if (ev.type === "error") {
        toast.error(ev.message)
      }
      // done: the refetch in `finally` replaces the optimistic UI
    }
  }
}

/**
 * Tools execute after their round froze (the `round` frame precedes the
 * tool_call events), so chips append to the LAST completed segment — the
 * round that called them. The fallback covers a stream that never sent
 * a round frame (defensive; the protocol always does).
 */
function appendTool(s: TurnStreams, tool: ToolEvent): TurnStreams {
  if (s.segments.length === 0) {
    return {
      ...s,
      current: { ...s.current, tools: [...s.current.tools, tool] },
    }
  }
  const segments = s.segments.slice()
  const last = segments[segments.length - 1]
  segments[segments.length - 1] = { ...last, tools: [...last.tools, tool] }
  return { ...s, segments }
}
