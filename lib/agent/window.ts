import type { AgentChatMessage } from "@/lib/agent/types"

/**
 * History windowing for the agent loop (ADR-0033). The context window
 * (LLM_CTX) is finite and the local model is slow, so the loop sends only
 * a bounded, sanitized slice of the thread history per request: the most
 * recent user turn plus its trailing assistant/tool messages, capped by
 * count and per-field length.
 */

/** Hard cap on history messages per request (user + assistant + tool). */
export const AGENT_HISTORY_MAX_MESSAGES = 24

/** Per-field character cap before truncation (content, args). */
export const AGENT_MAX_FIELD_CHARS = 4000

/** Tool rounds allowed per chat turn before forcing a final answer. */
export const AGENT_MAX_TURNS = 5

/**
 * Reduces the in-memory window one more level and marks where truncation
 * happened so the model understands text was cut (not lost by accident).
 */
const TRUNCATION_SUFFIX = "…"

/**
 * Last-boundary slice of the history:
 * - fields longer than AGENT_MAX_FIELD_CHARS are truncated with "…" (a
 *   whole-prompt overflow at these caps is guarded separately in the loop
 *   by the LLM_CTX estimate),
 * - the window never starts mid-protocol: slicing can otherwise begin on
 *   an assistant/tool_call/tool answer whose request-side user message
 *   fell out of the window — llama-server rejects orphan tool continuations.
 *   The start shifts forward to the next user message so every remaining
 *   tool round is complete. A window without any user message is useless
 *   (nothing anchors the model to the current thread) → empty array.
 */
export function windowHistory(
  messages: AgentChatMessage[]
): AgentChatMessage[] {
  if (messages.length === 0) return []
  const capped = messages.slice(-AGENT_HISTORY_MAX_MESSAGES)

  // The first (oldest) user message inside the capped window anchors the
  // slice: everything from it onward is kept, everything before it is
  // dropped (the newest message is the current turn and is always inside
  // the cap). Keeps the protocol pairing intact even after heavy trimming
  // while honoring the 24-message cap.
  const start = capped.findIndex((m) => m.role === "user")
  if (start === -1) return []

  const windowed = capped.slice(start).map(truncateMessage)
  if (windowed.length > AGENT_HISTORY_MAX_MESSAGES) {
    return windowed.slice(-AGENT_HISTORY_MAX_MESSAGES)
  }
  return windowed
}

function truncateMessage(m: AgentChatMessage): AgentChatMessage {
  const out: AgentChatMessage = {
    ...m,
    content: truncateField(m.content),
  }
  if (out.tool_calls) {
    out.tool_calls = out.tool_calls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: truncateField(call.function.arguments),
      },
    }))
  }
  return out
}

function truncateField(s: string): string {
  if (s.length <= AGENT_MAX_FIELD_CHARS) return s
  return s.slice(0, AGENT_MAX_FIELD_CHARS) + TRUNCATION_SUFFIX
}

/**
 * Cheap char estimate of the request size (roughly 4 chars ≈ 1 token):
 * content and tool args lengths plus a fixed per-message overhead for the
 * JSON envelope role/id fields. Used by the loop to warn once per turn
 * when the prompt approaches LLM_CTX.
 */
export function estimatePromptChars(messages: AgentChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += m.content.length + 20
    if (m.tool_calls) {
      for (const c of m.tool_calls) {
        chars += c.function.name.length + c.function.arguments.length + 20
      }
    }
  }
  return chars
}
