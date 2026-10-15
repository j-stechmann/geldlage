import { appendMessage, touchThread } from "@/lib/agent/store"
import { AGENT_NO_ANSWER_TEXT } from "@/lib/agent/constants"
import type { AgentLoopEvent } from "@/lib/agent/types"

/**
 * Turn persistence (ADR-0033): the loop is persistence-free by design, so
 * the route's write-side state machine lives here instead. Claude
 * Code-style transcript: ONE assistant row per `round` event (that
 * round's prose + reasoning + its tool calls as wire JSON) and one tool
 * row per tool_result, in threadSeq order identical to streamed event
 * order — the stored rows double as the replayable protocol history for
 * later turns.
 *
 * The tool_call → tool_result pairing exploits the loop's strict
 * sequential execution: the tool_call immediately preceding a tool_result
 * IS its pair — the raw args are remembered here (the result event
 * doesn't carry them); the wire id comes from the events themselves.
 */

/** Per-tool-row char cap for persisted tool results (loop caps args). */
const TOOL_RESULT_MAX_CHARS = 8000

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
        content: ev.result.slice(0, TOOL_RESULT_MAX_CHARS),
        toolName: ev.name,
        toolArgs: this.pendingToolArgs,
        toolCallId: ev.id,
      })
      this.pendingToolArgs = null
      return null
    }
    if (ev.type === "round") {
      // A fully empty round (degenerate retry round) produces no row.
      if (ev.content === "" && ev.reasoning === null && ev.calls.length === 0) {
        return null
      }
      // Empty prose on a round WITH calls persists with empty content —
      // the protocol needs the assistant tool_calls message on record;
      // the message list renders such rounds as chips only. Empty prose
      // on a callless (final) round keeps the placeholder body rule: an
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
