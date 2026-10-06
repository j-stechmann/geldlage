import { getConfig } from "@/lib/config"
import { streamAgentChat } from "@/lib/agent/chat-client"
import { agentSystemPrompt } from "@/lib/agent/system-prompt"
import { agentTools, toolByName } from "@/lib/agent/tools"
import {
  AGENT_MAX_TURNS,
  estimatePromptChars,
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
 * Persistence-free by design — it only yields AgentLoopEvents; the route
 * streams them to the client and persists the final assistant message once
 * the done event arrives (which is why done carries content+reasoning but
 * a null messageId).
 */

/** Rough chars→tokens divisor, same estimate convention as lib/llm. */
const CHARS_PER_TOKEN = 4

/** Fraction of the context window the prompt should stay under. */
const CTX_HEADROOM = 0.9

/**
 * One chat turn: history in, event stream out. Round semantics:
 * - round 1..AGENT_MAX_TURNS-1 may request tools; each tool_calls event is
 *   executed (args parse failures and tool errors become JSON error
 *   results, so the model sees the problem and can self-correct), the
 *   OpenAI protocol trio (assistant tool_calls message + per-call tool
 *   messages) extends the messages, and the next round sees the results.
 * - the final allowed round calls WITHOUT the tools field (tools strip
 *   forces a final answer); any tool calls it still emits are ignored.
 * - an empty answer on a tools-allowed round gets exactly one tools-free
 *   retry, then the turn ends regardless — a silent exit beats a hang.
 */
export async function* runAgentTurn(params: {
  history: AgentChatMessage[]
  uid: number
  signal?: AbortSignal
}): AsyncGenerator<AgentLoopEvent> {
  const cfg = getConfig()
  const system: AgentPromptMessage = {
    role: "system",
    content: agentSystemPrompt(
      cfg.LLM_LANGUAGE,
      new Date(),
      agentTools.map((t) => t.name)
    ),
  }
  const msgs: AgentPromptMessage[] = [system, ...windowHistory(params.history)]

  // Once per turn (not per round): the estimate uses the windowed history
  // (the system turn's fixed overhead is negligible next to the 24-cap),
  // chars/4 ≈ tokens like the lib/llm guard. Exceeding ctx gets output
  // clamped by the server — an operator-level misconfiguration surfaced
  // loudly instead of silently truncating answers.
  const promptChars =
    estimatePromptChars(windowHistory(params.history)) + system.content.length
  if (promptChars > cfg.LLM_CTX * CHARS_PER_TOKEN * CTX_HEADROOM) {
    console.warn(
      `[agent] estimated prompt ${promptChars} chars (~${Math.ceil(
        promptChars / CHARS_PER_TOKEN
      )} tokens) exceeds 90% of LLM_CTX (${cfg.LLM_CTX}) — output may clamp`
    )
  }

  let roundsLeft = AGENT_MAX_TURNS
  // Set when a round ended empty: the next round runs tools-free and ends
  // the turn no matter what (one retry max, never a silent-loop hang).
  let retryWithoutTools = false
  let content = ""
  let reasoning: string | null = null

  while (roundsLeft > 0) {
    roundsLeft--
    // tools-free on the granted-final round or on the empty-answer retry
    const noTools = retryWithoutTools || roundsLeft === 0
    retryWithoutTools = false

    let roundContent = ""
    const calls: Array<{ id: string; name: string; args: string }> = []

    for await (const ev of streamAgentChat(msgs, {
      signal: params.signal,
      disableTools: noTools,
    })) {
      if (ev.type === "reasoning") {
        reasoning = (reasoning ?? "") + ev.text
        yield { type: "reasoning", text: ev.text }
      } else if (ev.type === "content") {
        roundContent += ev.text
        yield { type: "content", text: ev.text }
      } else if (ev.type === "tool_calls") {
        calls.push(...ev.calls)
      }
    }
    content += roundContent

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
        yield { type: "tool_call", name: call.name, args: call.args || "{}" }
        const resultString = await executeToolCall(call.name, call.args, {
          uid: params.uid,
        })
        yield { type: "tool_result", name: call.name, result: resultString }
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
    if (roundContent.length === 0 && !noTools) {
      retryWithoutTools = true
      continue
    }
    yield { type: "done", messageId: null, content, reasoning }
    return
  }
}

/**
 * Executes one tool call with full error absorption: parse errors, unknown
 * tools and thrown tool errors all become JSON error objects — the loop
 * never throws on tool misbehavior (stream errors DO propagate, those are
 * infrastructure, not model mistakes).
 */
async function executeToolCall(
  name: string,
  rawArgs: string,
  ctx: { uid: number }
): Promise<string> {
  const tool = toolByName(name)
  if (!tool) {
    return JSON.stringify({ error: `unknown tool: ${name}` })
  }
  let args: unknown
  try {
    args = JSON.parse(rawArgs || "{}")
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    return JSON.stringify((await tool.execute(args, ctx)) ?? {})
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
