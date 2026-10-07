/**
 * Streamed tool-call fragment folding (ADR-0033): OpenAI deltas spread one
 * call's fields over many frames (`delta.tool_calls[i].function.arguments`
 * pieces concatenate by `index`); a call's args are only valid when
 * complete, so the folding is buffered and emitted once at stream end —
 * the loop must never JSON.parse a half-arrived argument string. Split
 * from lib/agent/chat-client.ts so the wire-shape knowledge (WireChunk)
 * lives beside its consumer fold, and the client stays a thin transport.
 */

/** One streamed (or folded) chunk of an agent chat completion. */
export type ChatStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | {
      type: "tool_calls"
      calls: Array<{ id: string; name: string; args: string }>
    }

/** One accumulated (complete) tool call, valid for execution. */
export interface CompletedToolCall {
  id: string
  name: string
  args: string
}

interface WireDeltaToolCall {
  index?: unknown
  id?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: unknown
      reasoning_content?: unknown
      tool_calls?: WireDeltaToolCall[]
    }
  }>
}

/** Re-exported for the client's non-streaming fallback fold. */
export type { WireChunk }

/**
 * Accumulator for streamed tool calls keyed by fragment index: first id
 * and first non-empty name win, argument strings concatenate. A plain
 * array with index holes survives `array[i] = …` writes even when frames
 * skip around (llama-server emits dense indices, but the protocol only
 * promises `index`).
 */
export class ToolCallAccumulator {
  private calls: Array<CompletedToolCall | null> = []

  /** Absorbs one delta's tool_call fragments (must match `index` ordering). */
  addFragments(fragments: unknown[]): void {
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== "object") continue
      const fr = fragment as WireDeltaToolCall
      const idx =
        typeof fr.index === "number" && Number.isInteger(fr.index)
          ? fr.index
          : this.calls.length
      let call = this.calls[idx]
      if (!call) {
        call = { id: "", name: "", args: "" }
        this.calls[idx] = call
      }
      if (typeof fr.id === "string" && fr.id && !call.id) {
        call.id = fr.id
      }
      if (fr.function && typeof fr.function === "object") {
        if (
          typeof fr.function.name === "string" &&
          fr.function.name &&
          !call.name
        ) {
          call.name = fr.function.name
        }
        if (typeof fr.function.arguments === "string") {
          call.args += fr.function.arguments
        }
      }
    }
  }

  /** Complete calls (a name is the minimum validity bar); id synthesized if missing. */
  complete(): CompletedToolCall[] {
    return this.calls.filter(
      (c): c is CompletedToolCall => c !== null && c.name !== ""
    )
  }
}

/**
 * Folds a non-streamed message's tool_calls array into the same complete
 * shape (fallback path: a backend that ignored `stream`). Missing ids get
 * synthesized (`call_<n>`), name-less entries dropped, args default "{}".
 */
export function foldToolCalls(
  raw: unknown
): Array<{ id: string; name: string; args: string }> {
  const out: Array<{ id: string; name: string; args: string }> = []
  if (!Array.isArray(raw)) return out
  for (const call of raw) {
    if (!call || typeof call !== "object") continue
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } })
      .function
    const name = typeof fn?.name === "string" ? fn.name : ""
    if (!name) continue
    const fnArgs = fn?.arguments
    out.push({
      id:
        typeof (call as { id?: unknown }).id === "string"
          ? (call as { id: string }).id || `call_${out.length}`
          : `call_${out.length}`,
      name,
      args: typeof fnArgs === "string" ? fnArgs : "{}",
    })
  }
  return out
}
