import type { AgentChatMessage } from "@/lib/agent/types"
import type { ChatMessage } from "@/lib/db/schema"

/**
 * Rebuilds the OpenAI protocol history from stored chat rows — the
 * Claude Code-style replay (ADR-0033 amendment): the persisted
 * transcript (one assistant row per round carrying its tool_calls wire
 * JSON, one tool row per result paired by tool_call_id) maps back onto
 * the exact messages the loop originally sent, so follow-up turns see
 * which tools they already ran and what came back.
 *
 * Degradation rules (a broken trio is never sent):
 * - legacy rows (assistant without tool_calls / tool rows without
 *   tool_call_id) replay as plain user/assistant text; their tool rows
 *   are dropped — exactly the pre-amendment behavior,
 * - a concurrent send in a shared thread can interleave a foreign row
 *   between an assistant round and its tool rows: when the rows
 *   following an assistant-with-calls row are not exactly its paired
 *   tool results (in call order), the whole trio degrades to prose-only
 *   — llama-server rejects orphan tool continuations.
 */
export function rowsToPromptHistory(rows: ChatMessage[]): AgentChatMessage[] {
  const out: AgentChatMessage[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row.role === "user") {
      out.push({ role: "user", content: row.content })
      i++
      continue
    }
    if (row.role === "assistant") {
      const calls = parseToolCalls(row.toolCalls)
      if (calls.length === 0) {
        out.push({ role: "assistant", content: row.content })
        i++
        continue
      }
      // Consume exactly the tool rows this round's calls pair with, in
      // call order — any mismatch (interleaved foreign row, missing or
      // extra result) degrades the round to prose-only.
      const results: ChatMessage[] = []
      let paired = true
      for (let c = 0; c < calls.length; c++) {
        const expected = rows[i + 1 + c]
        if (
          !expected ||
          expected.role !== "tool" ||
          expected.toolCallId !== calls[c].id
        ) {
          paired = false
          break
        }
        results.push(expected)
      }
      if (paired) {
        out.push({ role: "assistant", content: row.content, tool_calls: calls })
        for (const r of results) {
          out.push({
            role: "tool",
            tool_call_id: r.toolCallId!,
            name: r.toolName ?? undefined,
            content: r.content,
          })
        }
        i += 1 + results.length
      } else {
        out.push({ role: "assistant", content: row.content })
        i++
      }
      continue
    }
    // Tool rows reach here only unpaired (legacy or degraded round) —
    // display-only, never replayed.
    i++
  }
  return out
}

/** Wire-shaped tool_calls JSON off an assistant row; [] when unusable. */
function parseToolCalls(
  raw: string | null
): NonNullable<AgentChatMessage["tool_calls"]> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as NonNullable<
      AgentChatMessage["tool_calls"]
    >
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
