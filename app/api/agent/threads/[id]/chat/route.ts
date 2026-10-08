import { NextRequest, NextResponse } from "next/server"
import { CHAT_MESSAGE_MAX_CHARS } from "@/lib/agent/constants"
import { AGENT_HISTORY_MAX_MESSAGES } from "@/lib/agent/window"
import { runAgentTurn } from "@/lib/agent/loop"
import { appendMessage, listRecentMessages } from "@/lib/agent/store"
import { maybeAutoTitle } from "@/lib/agent/thread-title"
import { requireThreadAccess } from "@/lib/agent/route-guard"
import { TurnPersister } from "@/lib/agent/turn-persister"
import {
  errorFrameMessage,
  sseFrame,
  sseResponseHeaders,
} from "@/lib/agent/sse-writer"
import type {
  AgentChatMessage,
  AgentLoopEvent,
} from "@/lib/agent/types"
import type { ChatMessage } from "@/lib/db/schema"

/** Race between the access gate and the store write: thread deleted. */
function deletedThreadResponse(err: unknown): NextResponse {
  const message = typeof err === "object" && err !== null ? String((err as Error).message) : ""
  if (message.includes("thread not found")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  throw err
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Bounded recent-read size for the chat route's history mapping: the loop
 * consumes at most AGENT_HISTORY_MAX_MESSAGES, but tool rows are filtered
 * out BEFORE windowHistory sees the list, so the read takes extra headroom
 * (5 turns × tool rows) to keep the post-filter window fully populated.
 */
const HISTORY_WINDOW = AGENT_HISTORY_MAX_MESSAGES * 2

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
    isFirstTurn = !listRecentMessages(id, HISTORY_WINDOW).some(
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

  // Windowed stored history INCLUDING the just-appended user message; the
  // loop re-windows/sanitizes it (windowHistory), and the loop's cap is
  // what makes reading only the recent slice safe — nothing older enters
  // the prompt anyway. Stored `reasoning` is display metadata only and is
  // not replayed to the model: reasoning tokens belong to the round that
  // produced them, the chat endpoint's request builder drops them anyway,
  // and replaying them across turns would bloat the prompt with stale
  // thinking traces.
  const history: AgentChatMessage[] = listRecentMessages(id, HISTORY_WINDOW)
    .filter((m) => m.role !== "tool")
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }))

  const persister = new TurnPersister(id)
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // request.signal fires when the client disconnects; forwarding it
      // into the loop aborts the in-flight LLM fetch instead of burning
      // the rest of the turn for nobody.
      try {
        // The persisted user row's id, echoed before the loop starts: the
        // client aligns its optimistic bubble against the authoritative
        // detail view (the first send lazily creates the thread, so the
        // detail fetch races the turn and can arrive already containing
        // this row — without the id, content-matching duplicates it).
        controller.enqueue(sseFrame("user", { id: userMessage.id }))
        for await (const ev of runAgentTurn({
          history,
          uid: gate.session.uid,
          signal: request.signal,
        })) {
          persistAndEnqueue(controller, persister, ev)
        }
      } catch (err) {
        // Infrastructure failures stream an error frame then close — the
        // client renders the message instead of hanging on a half-answer.
        const message = errorFrameMessage(err)
        if (message) controller.enqueue(sseFrame("error", { message }))
      } finally {
        // AI titling after the first turn (fire-and-forget, failures
        // swallowed): the single llama-server slot is free now that the
        // turn's SSE is fully enqueued. Deliberately unconditioned on the
        // turn outcome — an aborted/errored first turn still titles (the
        // user message is persisted and the guard in thread-title.ts
        // keeps a user-chosen name standing), so the thread is never
        // stuck on "Neuer Chat".
        if (isFirstTurn) maybeAutoTitle(id, content)
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
 * One loop event → persisted rows + SSE frame for the browser. Frame
 * names: content streams as `delta`, everything else keeps its event
 * name. The done frame echoes content+reasoning and carries the saved
 * message id so the client can align optimistic UI with the stored record.
 */
function persistAndEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  persister: TurnPersister,
  ev: AgentLoopEvent
): void {
  switch (ev.type) {
    case "reasoning":
      controller.enqueue(sseFrame("reasoning", { text: ev.text }))
      break
    case "content":
      controller.enqueue(sseFrame("delta", { text: ev.text }))
      break
    case "tool_call":
      controller.enqueue(
        sseFrame("tool_call", { name: ev.name, args: ev.args })
      )
      break
    case "tool_result":
      controller.enqueue(
        sseFrame("tool_result", { name: ev.name, result: ev.result })
      )
      break
    case "done": {
      const messageId = persister.onLoopEvent(ev)
      controller.enqueue(
        sseFrame("done", {
          messageId,
          content: ev.content,
          reasoning: ev.reasoning,
        })
      )
      break
    }
  }
}
