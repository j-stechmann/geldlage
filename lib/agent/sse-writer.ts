import { isTimeoutError } from "@/lib/llm/sse"

/**
 * SSE wire format for the agent chat endpoint (ADR-0033): frame encoding
 * (one event + one data line per frame, LF separators) and the error →
 * SSE-frame mapping for infrastructure failures. Split from the chat
 * route so the transport shape lives in one place and the route keeps
 * only protocol/persistence wiring.
 */

const encoder = new TextEncoder()

/**
 * The client-visible fallback for all non-timeout infrastructure failures.
 * Never embeds err.message: LlmHttpError carries up to 500 chars of the
 * llama-server response body, and the frame renders verbatim in the chat
 * UI — the detail is logged server-side instead.
 */
const GENERIC_LLM_FRAME = "LLM-Fehler — der Sprachdienst antwortet nicht korrekt."

/** Encodes one named SSE frame. */
export function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Headers for an infinite streaming SSE response. */
export function sseResponseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

/**
 * Maps a thrown loop/stream error to the client-visible error frame
 * message, or null when the client itself went away (abort — nothing left
 * to tell); the caller skips the frame then and just closes. Non-timeout
 * failures get the generic frame with the raw detail logged server-side.
 */
export function errorFrameMessage(err: unknown): string | null {
  if (isClientAbort(err)) return null
  if (isTimeoutError(err)) return "Timeout — die Antwort dauerte zu lange."
  console.error(
    "[agent] LLM turn failed:",
    err instanceof Error ? err.message : err
  )
  return GENERIC_LLM_FRAME
}

/** request.signal aborts surface as AbortError (client went away). */
function isClientAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  )
}
