import { NextRequest, NextResponse } from "next/server"
import { runAgentTurn } from "@/lib/agent/loop"
import {
  appendMessage,
  listMessages,
  roleOf,
  setTitleIfDefault,
  touchThread,
} from "@/lib/agent/store"
import type { AgentChatMessage } from "@/lib/agent/types"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Per-assistant-row char cap for persisted tool results (loop caps args). */
const TOOL_RESULT_MAX_CHARS = 8000

/**
 * One streamed agent turn as SSE. Owner and joined members may chat;
 * invited users are still title-preview-only → 404 (no existence
 * disclosure for foreign/unknown threads either).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params

  const role = roleOf(id, session.uid)
  if (role !== "owner" && role !== "member") {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

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
  if (!content || content.length > 8000) {
    return NextResponse.json(
      { error: "invalid_content", message: "Nachricht: 1–8000 Zeichen." },
      { status: 400 }
    )
  }

  setTitleIfDefault(id, content)
  appendMessage(id, { userId: session.uid, role: "user", content })

  // Full stored history INCLUDING the just-appended user message; the
  // loop windows/sanitizes it further (windowHistory). Stored `reasoning`
  // is display metadata only and is not replayed to the model: reasoning
  // tokens belong to the round that produced them, the chat endpoint's
  // request builder drops them anyway, and replaying them across turns
  // would bloat the prompt with stale thinking traces.
  const history: AgentChatMessage[] = listMessages(id)
    .filter((m) => m.role !== "tool")
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }))

  const encoder = new TextEncoder()
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // request.signal fires when the client disconnects; forwarding it
      // into the loop aborts the in-flight LLM fetch instead of burning
      // the rest of the turn for nobody.
      let pendingToolArgs: string | null = null
      try {
        for await (const ev of runAgentTurn({
          history,
          uid: session.uid,
          signal: request.signal,
        })) {
          if (ev.type === "reasoning") {
            controller.enqueue(
              encoder.encode(frame("reasoning", { text: ev.text }))
            )
          } else if (ev.type === "content") {
            controller.enqueue(
              encoder.encode(frame("delta", { text: ev.text }))
            )
          } else if (ev.type === "tool_call") {
            // Calls execute strictly sequentially in the loop, so the
            // tool_call immediately preceding a tool_result IS its pair —
            // remember the raw args here (the result event doesn't carry
            // them) for the persistence row below.
            pendingToolArgs = ev.args
            controller.enqueue(
              encoder.encode(
                frame("tool_call", { name: ev.name, args: ev.args })
              )
            )
          } else if (ev.type === "tool_result") {
            // The loop is persistence-free by design: tool activity is
            // written HERE, not in the loop. Persisting per tool_result
            // (not batched at done — done carries no calls) keeps the
            // threadSeq order identical to the streamed event order.
            appendMessage(id, {
              userId: null,
              role: "tool",
              content: ev.result.slice(0, TOOL_RESULT_MAX_CHARS),
              toolName: ev.name,
              toolArgs: pendingToolArgs,
            })
            pendingToolArgs = null
            controller.enqueue(
              encoder.encode(
                frame("tool_result", { name: ev.name, result: ev.result })
              )
            )
          } else if (ev.type === "done") {
            // The loop never persists — the final assistant row (content +
            // reasoning display trace) is written exactly once here and the
            // saved id is handed to the client so it can align optimistic
            // UI with the stored record.
            let saved = null
            if (ev.content || ev.reasoning) {
              saved = appendMessage(id, {
                userId: null,
                role: "assistant",
                content: ev.content,
                reasoning: ev.reasoning,
              }).id
            }
            touchThread(id)
            controller.enqueue(
              encoder.encode(
                frame("done", {
                  messageId: saved,
                  content: ev.content,
                  reasoning: ev.reasoning,
                })
              )
            )
          }
        }
      } catch (err) {
        // Infrastructure failures stream an error frame then close — the
        // client renders the message instead of hanging on a half-answer.
        const message = isClientAbort(err)
          ? null
          : isTimeout(err)
            ? "Timeout — die Antwort dauerte zu lange."
            : `LLM-Fehler: ${err instanceof Error ? err.message : "unbekannt"}`
        if (message)
          controller.enqueue(encoder.encode(frame("error", { message })))
      } finally {
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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

/** request.signal aborts surface as AbortError (client went away). */
function isClientAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  )
}

/** Deadline errors (stream stall, fetch timeout) — see lib/llm/sse.ts. */
function isTimeout(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    (err instanceof Error && err.name === "TimeoutError") ||
    (err instanceof Error && err.name === "SseTimeoutError")
  )
}
