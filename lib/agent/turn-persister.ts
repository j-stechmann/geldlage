import { appendMessage, touchThread } from "@/lib/agent/store"
import { truncateToolResult } from "@/lib/agent/window"
import { AGENT_NO_ANSWER_TEXT } from "@/lib/agent/constants"
import type { AgentLoopEvent } from "@/lib/agent/types"

/**
 * Turn persistence (ADR-0033): the loop is persistence-free by design, so
 * the route's write-side state machine lives here instead. Claude
 * Code-style transcript: ONE assistant row per `round` event (that
 * round's prose + reasoning + its tool calls as wire JSON — except
 * retry-flagged degenerate rounds, which enter nothing) and one tool
 * row per tool_result, in threadSeq order identical to streamed event
 * order — the stored rows double as the replayable protocol history
 * for later turns.
 *
 * The tool_call → tool_result pairing exploits the loop's strict
 * sequential execution: the tool_call immediately preceding a tool_result
 * IS its pair — the raw args are remembered here (the result event
 * doesn't carry them); the wire id comes from the events themselves.
 *
 * Stored tool rows are capped at the per-field cap with the shared
 * marker (lib/agent/window.ts truncateToolResult — the same cut the
 * loop applies to its wire copy); TOOL_RESULT_MAX_CHARS is re-exported
 * for the historical import surface.
 */
export { TOOL_RESULT_MAX_CHARS } from "@/lib/agent/window"

export class TurnPersister {
  private threadId: string
  private pendingToolArgs: string | null = null
  private lastRowId: string | null = null

  constructor(threadId: string) {
    this.threadId = threadId
  }

  /**
   * Writes the rows an AgentLoopEvent implies; returns the saved row id
   * for round events (the route echoes the LAST one in the done frame's
   * messageId), the last persisted row id on done, null otherwise.
   */
  onLoopEvent(ev: AgentLoopEvent): string | null {
    if (ev.type === "tool_call") {
      this.pendingToolArgs = ev.args
      return null
    }
    if (ev.type === "tool_result") {
      appendMessage(this.threadId, {
        userId: null,
        role: "tool",
        content: truncateToolResult(ev.result),
        toolName: ev.name,
        toolArgs: this.pendingToolArgs,
        toolCallId: ev.id,
      })
      this.pendingToolArgs = null
      return null
    }
    if (ev.type === "round") {
      // A retry-flagged round (empty prose, no calls on a tools-allowed
      // round) continues the turn with one tools-free retry and entered
      // nothing into the wire history — no row, even when it streamed a
      // reasoning trace: the placeholder body would permanently fake an
      // answer the retry may still give, and rowsToPromptHistory would
      // replay that fake into every later prompt.
      if (ev.retry) {
        return null
      }
      // A fully empty round produces no row (the answer-less turn end
      // with reasoning off — nothing display-worthy happened).
      if (ev.content === "" && ev.reasoning === null && ev.calls.length === 0) {
        return null
      }
      // Empty prose on a round WITH calls persists with empty content —
      // the protocol needs the assistant tool_calls message on record;
      // the message list renders such rounds as chips only. Empty prose
      // on a callless round that ends the turn (the only callless
      // rounds reaching here) keeps the placeholder body rule: an
      // empty-content row would render as an empty bubble after the
      // post-done refetch, and the reasoning trace stays in the
      // collapsible "Denkprozess".
      const content =
        ev.content !== ""
          ? ev.content
          : ev.calls.length === 0
            ? AGENT_NO_ANSWER_TEXT
            : ""
      const saved = appendMessage(this.threadId, {
        userId: null,
        role: "assistant",
        content,
        reasoning: ev.reasoning,
        toolCalls:
          ev.calls.length > 0
            ? JSON.stringify(
                ev.calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.args },
                }))
              )
            : null,
      })
      this.lastRowId = saved.id
      return saved.id
    }
    if (ev.type === "done") {
      touchThread(this.threadId)
      return this.lastRowId
    }
    return null
  }
}
