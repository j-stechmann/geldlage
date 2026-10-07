import { appendMessage, touchThread } from "@/lib/agent/store"
import type { AgentLoopEvent } from "@/lib/agent/types"

/**
 * Turn persistence (ADR-0033): the loop is persistence-free by design, so
 * the route's write-side state machine lives here instead. Persists tool
 * activity per tool_result (threadSeq order stays identical to streamed
 * event order) and the final assistant row (content + reasoning display
 * trace) at done.
 *
 * The tool_call → tool_result pairing exploits the loop's strict
 * sequential execution: the tool_call immediately preceding a tool_result
 * IS its pair — the raw args are remembered here (the result event doesn't
 * carry them) for the persistence row.
 */

/** Per-assistant-row char cap for persisted tool results (loop caps args). */
const TOOL_RESULT_MAX_CHARS = 8000

export class TurnPersister {
  private threadId: string
  private pendingToolArgs: string | null = null

  constructor(threadId: string) {
    this.threadId = threadId
  }

  /**
   * Writes the rows an AgentLoopEvent implies; returns the saved message
   * id for the done event (null when nothing was persisted — an empty
   * final answer does not produce a row).
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
      })
      this.pendingToolArgs = null
      return null
    }
    if (ev.type === "done") {
      let saved: string | null = null
      if (ev.content || ev.reasoning) {
        saved = appendMessage(this.threadId, {
          userId: null,
          role: "assistant",
          content: ev.content,
          reasoning: ev.reasoning,
        }).id
      }
      touchThread(this.threadId)
      return saved
    }
    return null
  }
}
