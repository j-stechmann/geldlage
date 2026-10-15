import { isTimeoutError } from "@/lib/llm/sse"
import { isThreadNotFoundError } from "@/lib/agent/store/messages"

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
const GENERIC_LLM_FRAME =
  "LLM-Fehler — der Sprachdienst antwortet nicht korrekt."

/**
 * The owner of a shared thread can delete it while a member's turn is
 * streaming: the persister's append then throws thread-not-found
 * mid-stream. Expected concurrency, not an infrastructure failure —
 * the member deserves the truth instead of a Sprachdienst blame.
 */
const THREAD_DELETED_FRAME = "Dieser Chat wurde gelöscht."

/** Encodes one named SSE frame. */
export function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * Enqueues one frame via the controller. A TypeError from enqueue means
 * the response stream left the readable state — the client disconnected
 * and the stream cancellation raced (and won) against the request.signal
 * abort, whose AbortError surfaces separately from the in-flight fetch.
 * Rethrown as a named AbortError so errorFrameMessage classifies it as
 * client-gone instead of logging a phantom "[agent] LLM turn failed".
 */
export function enqueueFrame(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: unknown
): void {
  // Encode BEFORE the try: a serialization TypeError (circular refs,
  // BigInt) must not reach the catch below, whose TypeError → AbortError
  // conversion is only valid for a cancelled stream.
  const frame = sseFrame(event, data)
  try {
    controller.enqueue(frame)
  } catch (err) {
    if (err instanceof TypeError) {
      throw new DOMException("response stream cancelled", "AbortError")
    }
    throw err
  }
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
 * to tell); the caller skips the frame then and just closes. Thread
 * deletion gets its own frame (warn-tagged — expected, not a failure);
 * other non-timeout failures get the generic frame with the raw detail
 * logged server-side.
 */
export function errorFrameMessage(err: unknown): string | null {
  if (isClientAbort(err)) return null
  if (isTimeoutError(err)) return "Timeout — die Antwort dauerte zu lange."
  if (isThreadNotFoundError(err)) {
    console.warn("[agent] thread deleted mid-turn:", err.message)
    return THREAD_DELETED_FRAME
  }
  console.error(
    "[agent] LLM turn failed:",
    err instanceof Error ? err.message : err
  )
  return GENERIC_LLM_FRAME
}

/**
 * Client disconnects surface as AbortError: the forwarded request.signal
 * aborting the in-flight LLM fetch, or (via enqueueFrame) a frame hitting
 * an already-cancelled response stream.
 */
function isClientAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  )
}
