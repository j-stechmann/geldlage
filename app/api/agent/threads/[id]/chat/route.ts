import { NextRequest, NextResponse } from "next/server"
import { CHAT_MESSAGE_MAX_CHARS } from "@/lib/agent/constants"
import { AGENT_HISTORY_MAX_MESSAGES } from "@/lib/agent/window"
import { runAgentTurn } from "@/lib/agent/loop"
import { rowsToPromptHistory } from "@/lib/agent/history"
import {
  appendMessage,
  isThreadNotFoundError,
  listRecentMessages,
} from "@/lib/agent/store"
import { maybeAutoTitle } from "@/lib/agent/thread-title"
import { requireThreadAccess } from "@/lib/agent/route-guard"
import { TurnPersister } from "@/lib/agent/turn-persister"
import {
  enqueueFrame,
  errorFrameMessage,
  sseResponseHeaders,
  startSseKeepalive,
} from "@/lib/agent/sse-writer"
import type { AgentLoopEvent } from "@/lib/agent/types"
import type { ChatMessage } from "@/lib/db/schema"

/** Race between the access gate and the store write: thread deleted. */
function deletedThreadResponse(err: unknown): NextResponse {
  if (isThreadNotFoundError(err)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  throw err
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * One streamed agent turn as SSE (ADR-0033). Route = protocol wiring only:
 * the access gate, message validation and history mapping stay here; frame
 * encoding (sse-writer), write-side persistence (turn-persister) and the
 * turn state machine (loop) are separate modules. Owner and joined members
 * may chat; invited users are still title-preview-only → 404 (no
 * existence disclosure for foreign/unknown threads either).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const gate = await requireThreadAccess(request, id, ["owner", "member"])
  if (!gate.ok) return gate.response

  const body = (await request.json().catch(() => null)) as {
    content?: unknown
  } | null
  if (typeof body?.content !== "string") {
    return NextResponse.json(
      { error: "invalid_content", message: "Nachricht fehlt." },
      { status: 400 }
    )
  }
  const content = body.content.trim()
  if (!content || content.length > CHAT_MESSAGE_MAX_CHARS) {
    return NextResponse.json(
      {
        error: "invalid_content",
        message: `Nachricht: 1–${CHAT_MESSAGE_MAX_CHARS} Zeichen.`,
      },
      { status: 400 }
    )
  }

  // Was this the thread's first user turn? (Read BEFORE appending.) A
  // bounded recent read can't answer "any user message at all", but a
  // thread old enough to overflow the window-by-headroom necessarily has
  // user messages, so the check is only load-bearing for small threads.
  // Both reads live inside the catch: the gate's roleOf check and the
  // insert are separate transactions, so an owner deleting the thread in
  // another session between them must surface as the same 404 body (never
  // a 500 from appendMessage's internal "thread not found" throw).
  let isFirstTurn: boolean
  let userMessage: ChatMessage
  try {
    isFirstTurn = !listRecentMessages(id, AGENT_HISTORY_MAX_MESSAGES).some(
      (m) => m.role === "user"
    )
    userMessage = appendMessage(id, {
      userId: gate.session.uid,
      role: "user",
      content,
    })
  } catch (err) {
    return deletedThreadResponse(err)
  }

  // Replayable transcript INCLUDING the just-appended user message: the
  // stored rows map back onto the protocol messages (assistant tool
  // rounds with their paired tool results), and the loop re-fits the
  // window to the LLM_CTX-derived budget (windowHistory) — which is
  // what makes reading only the recent slice safe: nothing older enters
  // the prompt anyway. Stored `reasoning` is display metadata only and
  // is not replayed to the model: reasoning tokens belong to the round
  // that produced them, and replaying them across turns would bloat
  // the prompt with stale thinking traces.
  const history = rowsToPromptHistory(
    listRecentMessages(id, AGENT_HISTORY_MAX_MESSAGES)
  )

  const persister = new TurnPersister(id)
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Keepalive watchdog: between the `user` frame and the first
      // `delta`/`reasoning` frame the stream can carry no bytes for
      // minutes (single llama-server slot, label batches queue ahead) —
      // proxies with idle read timeouts would cut the turn. Pings a
      // comment frame only during genuine silence (activity() restarts
      // the window after every real frame).
      const keepalive = startSseKeepalive(controller)
      // request.signal fires when the client disconnects; forwarding it
      // into the loop aborts the in-flight LLM fetch instead of burning
      // the rest of the turn for nobody.
      try {
        // The persisted user row's id, echoed before the loop starts: the
        // client aligns its optimistic bubble against the authoritative
        // detail view (the first send lazily creates the thread, so the
        // detail fetch races the turn and can arrive already containing
        // this row — without the id, content-matching duplicates it).
        enqueueFrame(controller, "user", { id: userMessage.id })
        keepalive.activity()
        for await (const ev of runAgentTurn({
          history,
          uid: gate.session.uid,
          signal: request.signal,
        })) {
          persistAndEnqueue(controller, persister, ev)
          keepalive.activity()
        }
      } catch (err) {
        // Infrastructure failures stream an error frame then close — the
        // client renders the message instead of hanging on a half-answer.
        // Client-gone errors (signal abort, cancelled stream) classify as
        // null: nothing left to tell.
        const message = errorFrameMessage(err)
        if (message) enqueueFrame(controller, "error", { message })
      } finally {
        // AI titling after the first turn (fire-and-forget, failures
        // swallowed): the single llama-server slot is free now that the
        // turn's SSE is fully enqueued. Deliberately unconditioned on the
        // turn outcome — an aborted/errored first turn still titles (the
        // user message is persisted and the guard in thread-title.ts
        // keeps a user-chosen name standing), so the thread is never
        // stuck on "Neuer Chat".
        if (isFirstTurn) maybeAutoTitle(id, content)
        keepalive.stop()
        // A client disconnect throws out of enqueue (not close) — swallow
        // so teardown never masks the original error.
        try {
          controller.close()
        } catch {
          // already closed / disconnected
        }
      }
    },
  })

  return new Response(stream, { headers: sseResponseHeaders() })
}

/**
 * One loop event → persisted rows + SSE frame for the browser: EVERY event
 * goes through the persister first (one assistant row per `round`, except
 * retry-flagged degenerate rounds; one tool row per tool_call/tool_result
 * pair), then the frame streams.
 * Frame names: content streams as `delta`, `round` is an empty segment
 * boundary for the client, everything else keeps its event name. The
 * done frame carries the last persisted row id (onLoopEvent returns it
 * on done) so the client can align optimistic UI with the stored record.
 */
function persistAndEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  persister: TurnPersister,
  ev: AgentLoopEvent
): void {
  const messageId = persister.onLoopEvent(ev)
  switch (ev.type) {
    case "reasoning":
      enqueueFrame(controller, "reasoning", { text: ev.text })
      break
    case "content":
      enqueueFrame(controller, "delta", { text: ev.text })
      break
    case "round":
      enqueueFrame(controller, "round", {})
      break
    case "tool_call":
      enqueueFrame(controller, "tool_call", { name: ev.name, args: ev.args })
      break
    case "tool_result":
      enqueueFrame(controller, "tool_result", {
        name: ev.name,
        result: ev.result,
      })
      break
    case "done":
      enqueueFrame(controller, "done", { messageId })
      break
  }
}
