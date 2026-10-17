import { AGENT_MAX_FIELD_CHARS } from "@/lib/agent/constants"
import type { AgentChatMessage } from "@/lib/agent/types"

/**
 * History windowing for the agent loop (ADR-0033). The context window
 * (LLM_CTX) is finite and the local model is slow, so the loop sends
 * only a bounded, sanitized slice of the thread history per request:
 * the most recent messages fitting a char budget derived from LLM_CTX
 * (≈4 chars per token), anchored so the window never starts mid-turn.
 */

/**
 * Hard ceiling on history rows the chat route READS from the DB — bounds
 * the read + mapping cost, NOT the prompt (the token budget computed by
 * the loop is the prompt bound). A thread older than this slice is
 * ancient by window standards; nothing older enters the prompt anyway.
 */
export const AGENT_HISTORY_MAX_MESSAGES = 128

/** Share of the model context reserved for replayed history. */
export const HISTORY_CTX_SHARE = 0.5

/** Tool rounds allowed per chat turn before forcing a final answer. */
export const AGENT_MAX_TURNS = 5

/**
 * Reduces the in-memory window one more level and marks where truncation
 * happened so the model understands text was cut (not lost by accident).
 */
const TRUNCATION_SUFFIX = "…"

/**
 * Newest-anchored, estimate-based slice of the history:
 * - messages are taken from the newest backwards while the cumulative
 *   char estimate (estimatePromptChars, ≈4 chars/token) stays under
 *   `budgetChars` — the loop derives it from LLM_CTX × HISTORY_CTX_SHARE.
 *   The newest message is always kept even when it alone exceeds the
 *   budget: per-field truncation below is the bound that applies to it,
 *   and dropping the current turn's message would empty the window,
 * - fields longer than AGENT_MAX_FIELD_CHARS are truncated with "…",
 * - the window never starts mid-protocol: slicing can otherwise begin on
 *   an assistant/tool_call/tool answer whose request-side user message
 *   fell out of the window — llama-server rejects orphan tool
 *   continuations. The start shifts forward to the next user message so
 *   every remaining tool round is complete. A window without any user
 *   message is useless (nothing anchors the model to the current
 *   thread) → empty array.
 */
export function windowHistory(
  messages: AgentChatMessage[],
  budgetChars: number
): AgentChatMessage[] {
  if (messages.length === 0) return []

  // Take the newest run that fits the budget (the anchor shift below can
  // only shrink this slice, so the budget stays honored).
  let start = messages.length - 1
  let total = estimatePromptChars([messages[start]])
  while (start > 0) {
    const next = estimatePromptChars([messages[start - 1]])
    if (total + next > budgetChars) break
    total += next
    start--
  }

  // The first (oldest) user message inside the fitted window anchors the
  // slice: everything from it onward is kept, everything before it is
  // dropped. Keeps the protocol pairing intact even after heavy trimming
  // while honoring the budget.
  const anchor = messages.findIndex((m, i) => i >= start && m.role === "user")
  if (anchor === -1) return []

  return messages.slice(anchor).map(truncateMessage)
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
 * Marker appended when a tool result is cut at the cap. Without it the
 * model would read a syntactically broken JSON answer that looks like
 * the tool's real output instead of a capped copy — mid-turn on the
 * wire copy (the loop's msgs) and on later turns' replay of the stored
 * row (the persister) alike.
 */
const TOOL_RESULT_TRUNCATION_SUFFIX = " …[Ergebnis gekürzt]"

/**
 * Per-tool-result char cap: the slice kept when the marker is appended.
 * Aligned with AGENT_MAX_FIELD_CHARS because replayed tool rows pass
 * through truncateField above, which re-cuts anything beyond that cap
 * with a bare "…" — slice + marker must fit it exactly, or the replay
 * cut would silently drop the marker right back out of the model's
 * context.
 */
export const TOOL_RESULT_MAX_CHARS =
  AGENT_MAX_FIELD_CHARS - TOOL_RESULT_TRUNCATION_SUFFIX.length

/**
 * Bounds one tool result to the per-field cap, marking the cut. The
 * model-facing copies share this: the loop's wire history (a 200-
 * category get_category_totals is ~20k chars ≈ 5k tokens — alone enough
 * to push the next round's prompt past LLM_CTX) and the persister's
 * stored row (later turns replay it through windowHistory). The
 * streamed tool_result event keeps the full result for the UI.
 */
export function truncateToolResult(s: string): string {
  // Fits the replay cap as-is: no cut, no marker (truncateField would
  // pass it through untouched — marking an uncut result would lie).
  if (s.length <= AGENT_MAX_FIELD_CHARS) return s
  return s.slice(0, TOOL_RESULT_MAX_CHARS) + TOOL_RESULT_TRUNCATION_SUFFIX
}

/**
 * The shape the estimate reads: content plus optional tool calls. The
 * system message satisfies it too (no tool_calls), so the loop can
 * estimate its whole request array including the system turn.
 */
type EstimableMessage = Pick<AgentChatMessage, "content" | "tool_calls">

/**
 * Cheap char estimate of the request size (roughly 4 chars ≈ 1 token):
 * content and tool args lengths plus a fixed per-message overhead for the
 * JSON envelope role/id fields. Used by windowHistory's budget walk and
 * by the loop to warn per round when the request approaches LLM_CTX
 * (mid-turn tool output included).
 */
export function estimatePromptChars(messages: EstimableMessage[]): number {
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
