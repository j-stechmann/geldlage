import { getConfig } from "@/lib/config"
import { agentMaxTokens, streamAgentChat } from "@/lib/agent/chat-client"
import { agentSystemPrompt } from "@/lib/agent/system-prompt"
import { agentTools, toolsForRequest } from "@/lib/agent/tool-registry"
import { executeToolCall } from "@/lib/agent/tool-executor"
import {
  AGENT_MAX_TURNS,
  estimatePromptChars,
  HISTORY_CTX_SHARE,
  windowHistory,
} from "@/lib/agent/window"
import type {
  AgentChatMessage,
  AgentLoopEvent,
  AgentPromptMessage,
} from "@/lib/agent/types"

/**
 * The tool loop (ADR-0033): drives streamAgentChat round by round until the
 * model answers without requesting tools (or the turn budget runs out).
 * Persistence-free by design — it only yields AgentLoopEvents. Claude
 * Code-style transcript: every completed round is announced as one `round`
 * event (that round's prose, reasoning and tool calls), which the route's
 * persister writes as one assistant row — the stored rows double as the
 * replayable protocol history for later turns. A pure turn state machine:
 * registry access is read-only (wire tool list + system prompt names),
 * execution lives in tool-executor.ts.
 */

/** Rough chars→tokens divisor, same estimate convention as lib/llm. */
const CHARS_PER_TOKEN = 4

/**
 * One chat turn: history in, event stream out. Round semantics:
 * - round 1..AGENT_MAX_TURNS-1 may request tools; each tool_calls event is
 *   executed (args parse failures and tool errors become JSON error
 *   results, so the model sees the problem and can self-correct), the
 *   OpenAI protocol trio (assistant tool_calls message + per-call tool
 *   messages) extends the messages, and the next round sees the results.
 * - the final allowed round calls WITHOUT the tools field (tools strip
 *   forces a final answer); any tool calls it still emits are ignored
 *   and left out of its round event (no orphan transcript rows).
 * - an empty answer on a tools-allowed round gets exactly one tools-free
 *   retry, then the turn ends regardless — a silent exit beats a hang.
 *   The degenerate round announces itself `retry`-flagged on its round
 *   event (the persister writes no row for it).
 */
export async function* runAgentTurn(params: {
  history: AgentChatMessage[]
  uid: number
  signal?: AbortSignal
}): AsyncGenerator<AgentLoopEvent> {
  const cfg = getConfig()
  const wireTools = toolsForRequest()
  const system: AgentPromptMessage = {
    role: "system",
    content: agentSystemPrompt(
      cfg.LLM_LANGUAGE,
      new Date(),
      agentTools.map((t) => t.name)
    ),
  }
  // Estimate-based replay window: half the model context is reserved
  // for history (HISTORY_CTX_SHARE), leaving the rest for the system
  // prompt and output. Cut once per turn (not per round): later rounds
  // only append protocol messages to the msgs copy below. chars/4 ≈
  // tokens like the lib/llm guard.
  const windowed = windowHistory(
    params.history,
    cfg.LLM_CTX * CHARS_PER_TOKEN * HISTORY_CTX_SHARE
  )
  const msgs: AgentPromptMessage[] = [system, ...windowed]

  // Ctx guard mirroring the label path (lib/llm/client.ts): max_tokens +
  // estimated prompt must fit the server context (LLM_CTX, the `-c` flag
  // llama-server runs with). Exceeding it gets the output clamped
  // silently mid-answer — an operator-level misconfiguration surfaced
  // loudly instead (for most configs the window budget keeps the prompt
  // under half of ctx and only the completion budget makes the sum
  // reachable, but windowHistory keeps an oversized newest message
  // regardless — so small LLM_CTX values with large fields can trip the
  // guard on the prompt side alone). Re-estimated at the top of every
  // round: the assistant tool_calls message and tool results appended to
  // msgs grow the request mid-turn, and the estimate must see them.
  // Still advisory (console.warn only) — the clamp is a server-side
  // effect the loop cannot prevent, but the operator sees which rounds
  // of a turn exceeded it.
  const maxTokens = agentMaxTokens(cfg)

  let roundsLeft = AGENT_MAX_TURNS
  // Set when a round ended empty: the next round runs tools-free and ends
  // the turn no matter what (one retry max, never a silent-loop hang).
  let retryWithoutTools = false

  while (roundsLeft > 0) {
    const promptTokens = Math.ceil(estimatePromptChars(msgs) / CHARS_PER_TOKEN)
    if (maxTokens + promptTokens > cfg.LLM_CTX) {
      console.warn(
        `[agent] completion budget (${maxTokens}) + estimated prompt ` +
          `(${promptTokens} tokens) exceeds LLM_CTX (${cfg.LLM_CTX}) — the ` +
          `answer will be clamped mid-stream. Raise LLM_CTX on both sides ` +
          `(make llm LLM_CTX=… for the server; the app reads the same env ` +
          `var and must be restarted with it).`
      )
    }
    roundsLeft--
    // tools-free on the granted-final round or on the empty-answer retry
    const noTools = retryWithoutTools || roundsLeft === 0
    retryWithoutTools = false

    let roundContent = ""
    // Per-round trace: the round event carries only what this round
    // produced (stored reasoning never merges across rounds).
    let roundReasoning: string | null = null
    const calls: Array<{ id: string; name: string; args: string }> = []

    for await (const ev of streamAgentChat(msgs, {
      signal: params.signal,
      tools: noTools ? [] : wireTools,
    })) {
      if (ev.type === "reasoning") {
        roundReasoning = (roundReasoning ?? "") + ev.text
        yield { type: "reasoning", text: ev.text }
      } else if (ev.type === "content") {
        roundContent += ev.text
        yield { type: "content", text: ev.text }
      } else if (ev.type === "tool_calls") {
        calls.push(...ev.calls)
      }
    }

    // Retry lookahead, decided BEFORE the round event: an empty callless
    // round on a tools-allowed round is degenerate — the branch below
    // will run one tools-free retry, and the round enters nothing into
    // the wire history (no msgs entry is built for it), so the flag
    // tells the persister to write no row either: a placeholder would
    // permanently fake an answer the retry may still give.
    const retry = roundContent.length === 0 && calls.length === 0 && !noTools

    // One assistant record per completed round, before any execution:
    // the persister turns it into one row, so the stored transcript
    // replays as the same per-round protocol messages the wire history
    // below builds. Retry-flagged rounds are the exception — skipped by
    // the persister because they never reached the wire history. Tool
    // calls on a tools-free round are never executed, so they must not
    // enter the record either: the persister would write them into the
    // row's tool_calls JSON with no paired tool rows (a replay-degraded
    // orphan the message list renders as nothing).
    yield {
      type: "round",
      content: roundContent,
      reasoning: roundReasoning,
      calls: noTools
        ? []
        : calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      retry,
    }

    if (calls.length > 0 && !noTools) {
      // The assistant tool_calls message is protocol-required even when the
      // round streamed no prose — the following tool messages would
      // otherwise answer a request the model never sees on record.
      msgs.push({
        role: "assistant",
        content: roundContent,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args },
        })),
      })
      for (const call of calls) {
        yield {
          type: "tool_call",
          id: call.id,
          name: call.name,
          args: call.args || "{}",
        }
        const resultString = await executeToolCall(call.name, call.args, {
          uid: params.uid,
        })
        yield {
          type: "tool_result",
          id: call.id,
          name: call.name,
          result: resultString,
        }
        msgs.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: resultString,
        })
      }
      continue
    }

    // Turn ends here — except the degenerate empty answer on a
    // tools-allowed round: exactly one tools-free retry (the flag makes
    // the next round run without tools; the round after that ends the
    // turn no matter what), so the model cannot exit with silence after
    // burning rounds, but a genuinely empty answer never loops forever.
    if (retry) {
      retryWithoutTools = true
      continue
    }
    yield { type: "done" }
    return
  }
}
