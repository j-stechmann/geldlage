import { getConfig } from "@/lib/config"
import { LlmHttpError } from "@/lib/llm/client"
import { safeBody, sseGenerator } from "@/lib/llm/sse"
import {
  ToolCallAccumulator,
  foldToolCalls,
  type ChatStreamEvent,
  type WireChunk,
} from "@/lib/agent/tool-call-accumulator"
import type { AgentPromptMessage } from "@/lib/agent/types"

/**
 * Streaming chat-completions client for the agent loop (ADR-0033). Sits
 * one level below the loop (lib/agent/loop.ts): converts one chat request
 * into a typed event stream — reasoning fragments, content fragments, and
 * (after the stream ends) at most one accumulated tool_calls event. Shares
 * lib/llm/sse.ts frame parsing verbatim with the label path and reuses its
 * error conventions (LlmHttpError, TimeoutError propagation), so the route
 * can classify failures identically for both consumers.
 *
 * Dependency inversion: the wire `tools` array is injected via options —
 * the client knows nothing about the tool registry (lib/agent/
 * tool-registry.ts), so it can serve any completion (agent rounds, the
 * tools-free final round, one-shot title generation).
 */

/** Per-round wire tool shape: what toolsForRequest() produces. */
export type WireTool = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface StreamAgentChatOptions {
  signal?: AbortSignal
  /** Wire tools to advertise; empty/omitted ⇒ the field is left off (some
   * llama-server builds reject `tools: []`). */
  tools?: WireTool[]
}

/**
 * Non-streaming message fallback shape (a backend that ignored `stream` or
 * answered 200 with a JSON error-shaped body): one message object instead
 * of deltas.
 */
interface NonStreamingMessage {
  content?: unknown
  reasoning_content?: unknown
  tool_calls?: unknown
}

/**
 * One request → event stream. Tool-call fragments arrive spread over many
 * frames; they are buffered in the accumulator and yielded once after the
 * stream ends, because a call's args are only valid when complete — the
 * loop must never JSON.parse a half-arrived argument string.
 */
export async function* streamAgentChat(
  messages: AgentPromptMessage[],
  options?: StreamAgentChatOptions
): AsyncGenerator<ChatStreamEvent> {
  const cfg = getConfig()
  // Caller cancellation + per-request deadline combined: either abort tears
  // down the whole request/response. AbortSignal.any keeps the caller's
  // signal live across round boundaries (the loop passes the route's
  // request signal through).
  const signal = options?.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(cfg.LLM_TIMEOUT_MS)])
    : AbortSignal.timeout(cfg.LLM_TIMEOUT_MS)

  const root = cfg.LLM_BASE_URL.replace(/\/+$/, "")
  // Request body: reasoning budget reserves thinking tokens inside
  // max_tokens (same accounting as the label path); only sent when
  // reasoning is on. Tools are attached only when advertised —
  // `tool_choice: "auto"` lets the model answer directly when no call is
  // needed.
  const body: Record<string, unknown> = {
    messages: messages.map((m) => toWireMessage(m)),
    temperature: 0.3,
    max_tokens: (cfg.LLM_REASONING ? cfg.LLM_REASONING_BUDGET : 0) + 2048,
    stream: true,
  }
  if (cfg.LLM_REASONING) {
    body.reasoning_budget_tokens = cfg.LLM_REASONING_BUDGET
  }
  const wireTools = options?.tools ?? []
  if (wireTools.length > 0) {
    body.tools = wireTools
    body.tool_choice = "auto"
  }

  const res = await fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    throw new LlmHttpError(res.status, await safeBody(res))
  }

  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream") || !res.body) {
    // Fallback: a backend that ignored `stream: true` answered one JSON
    // message. Fold it into the same event vocabulary so the loop stays
    // shape-agnostic (mirrors readContent's fallback in lib/llm/client.ts).
    yield* nonStreamingEvents(res)
    return
  }

  const calls = new ToolCallAccumulator()

  for await (const frame of sseGenerator(res.body)) {
    let parsed: WireChunk
    try {
      parsed = JSON.parse(frame.data) as WireChunk
    } catch {
      // A malformed frame never carries usable intent — skipping whole is
      // safer than aborting a stream that otherwise parses (label path
      // JSON.parse is equally strict, but it can abort; here one frame is
      // one delta, so skipping loses at most one fragment).
      continue
    }
    const delta = parsed.choices?.[0]?.delta
    if (!delta) continue
    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content
    ) {
      yield { type: "reasoning", text: delta.reasoning_content }
    }
    if (typeof delta.content === "string" && delta.content) {
      yield { type: "content", text: delta.content }
    }
    if (Array.isArray(delta.tool_calls)) {
      calls.addFragments(delta.tool_calls)
    }
  }

  const complete = calls.complete()
  if (complete.length > 0) {
    yield { type: "tool_calls", calls: complete }
  }
}

/** Non-streaming fallback: fold one message JSON into 0..N events. */
async function* nonStreamingEvents(
  res: Response
): AsyncGenerator<ChatStreamEvent> {
  const payload = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: NonStreamingMessage }>
  } | null
  const message = payload?.choices?.[0]?.message
  if (!message) return
  if (
    typeof message.reasoning_content === "string" &&
    message.reasoning_content
  ) {
    yield { type: "reasoning", text: message.reasoning_content }
  }
  if (typeof message.content === "string" && message.content) {
    yield { type: "content", text: message.content }
  }
  const folded = foldToolCalls(message.tool_calls)
  if (folded.length > 0) {
    yield { type: "tool_calls", calls: folded }
  }
}

/** Loop input → wire message: protocol fields only (reasoning never leaves). */
function toWireMessage(m: AgentPromptMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content }
  if ("name" in m) wire.name = m.name
  if ("tool_call_id" in m) wire.tool_call_id = m.tool_call_id
  if ("tool_calls" in m) wire.tool_calls = m.tool_calls
  return wire
}

export type { WireChunk, ChatStreamEvent }
