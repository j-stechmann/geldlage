import { sseGenerator } from "@/lib/llm/sse"

/**
 * Client-side dispatch of the agent chat SSE protocol (ADR-0033): frames
 * are `event: <name>\ndata: <json>\n\n`. Sharing lib/llm/sse.ts's frame
 * parser (the same generator the server-side chat client consumes) replaces
 * the previously hand-rolled duplicate — one SSE parser in the codebase,
 * CRLF handling and final-frame semantics included.
 */

/** A parsed protocol event, after `event:`-name dispatch. */
export type AgentStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "done"; messageId: string | null }
  | { type: "error"; message: string }

interface FramePayload {
  text?: string
  name?: string
  args?: string
  result?: string
  message?: string
  messageId?: string | null
}

/**
 * Parses the response body into a typed event stream. The event NAME
 * decides routing — never substring-match the whole frame: a delta's
 * payload can legitimately contain "event: done" and would otherwise be
 * misrouted.
 */
export async function* parseAgentSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<AgentStreamEvent> {
  for await (const frame of sseGenerator(body)) {
    if (!frame.eventName) continue
    let payload: FramePayload
    try {
      payload = JSON.parse(frame.data) as FramePayload
    } catch {
      // malformed frame — skip
      continue
    }
    switch (frame.eventName) {
      case "reasoning":
        yield { type: "reasoning", text: payload.text ?? "" }
        break
      case "delta":
        yield { type: "delta", text: payload.text ?? "" }
        break
      case "tool_call":
        yield {
          type: "tool_call",
          name: payload.name ?? "",
          args: payload.args ?? "",
        }
        break
      case "tool_result":
        yield {
          type: "tool_result",
          name: payload.name ?? "",
          result: payload.result ?? "",
        }
        break
      case "done":
        yield { type: "done", messageId: payload.messageId ?? null }
        break
      case "error":
        yield {
          type: "error",
          message: payload.message ?? "Unbekannter Fehler.",
        }
        break
    }
  }
}
