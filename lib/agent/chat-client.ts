import { getConfig } from "@/lib/config"
import { LlmHttpError } from "@/lib/llm/client"
import { sseGenerator } from "@/lib/llm/sse"
import { toolsForRequest } from "@/lib/agent/tools"
import type { AgentPromptMessage } from "@/lib/agent/types"

/**
 * Streaming chat-completions client for the agent loop (ADR-0033). Sits
 * one level below the loop (lib/agent/loop.ts): converts one chat request
 * into a typed event stream — reasoning fragments, content fragments, and
 * (after the stream ends) at most one accumulated tool_calls event. Shares
 * lib/llm/sse.ts frame parsing verbatim with the label path and reuses its
 * error conventions (LlmHttpError, TimeoutError propagation), so the route
 * can classify failures identically for both consumers.
 */

/** One streamed (or folded) chunk of an agent chat completion. */
export type ChatStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | {
      type: "tool_calls"
      calls: Array<{ id: string; name: string; args: string }>
    }

/**
 * Non-streaming message fallback shape (a backend that ignored `stream` or
 * answered 200 with a JSON error-shaped body): one message object instead
 * of deltas.
 */
interface NonStreamingMessage {
  content?: unknown
  reasoning_content?: unknown
  tool_calls?: Array<{
    id?: unknown
    type?: unknown
    function?: { name?: unknown; arguments?: unknown }
  }>
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

/**
 * One request → event stream. Tool-call fragments arrive spread over many
 * frames (`delta.tool_calls[i].function.arguments` pieces concatenate by
 * `index`); they are buffered here and yielded once after the stream ends,
 * because a call's args are only valid when complete — the loop must never
 * JSON.parse a half-arrived argument string.
 */
export async function* streamAgentChat(
  messages: AgentPromptMessage[],
  options?: { signal?: AbortSignal; disableTools?: boolean }
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
  // reasoning is on. Tools are attached whenever the registry is non-empty
  // — `tool_choice: "auto"` lets the model answer directly when no call is
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
  const wireTools = options?.disableTools ? [] : toolsForRequest()
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

  // Accumulator for streamed tool calls keyed by fragment index: first id
  // and first non-empty name win, argument strings concatenate. A plain
  // array with index holes survives `array[i] = …` writes even when frames
  // skip around (llama-server emits dense indices, but the protocol only
  // promises `index`).
  const calls: Array<{ id: string; name: string; args: string } | null> = []

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
      for (const fragment of delta.tool_calls) {
        if (!fragment || typeof fragment !== "object") continue
        const idx =
          typeof fragment.index === "number" && Number.isInteger(fragment.index)
            ? fragment.index
            : calls.length
        let call = calls[idx]
        if (!call) {
          call = { id: "", name: "", args: "" }
          calls[idx] = call
        }
        if (typeof fragment.id === "string" && fragment.id && !call.id) {
          call.id = fragment.id
        }
        if (fragment.function && typeof fragment.function === "object") {
          if (
            typeof fragment.function.name === "string" &&
            fragment.function.name &&
            !call.name
          ) {
            call.name = fragment.function.name
          }
          if (typeof fragment.function.arguments === "string") {
            call.args += fragment.function.arguments
          }
        }
      }
    }
  }

  const complete = calls.filter(
    (c): c is { id: string; name: string; args: string } =>
      c !== null && c.name !== ""
  )
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
  const folded = foldToolCalls(message.tool_calls ?? [])
  if (folded.length > 0) {
    yield { type: "tool_calls", calls: folded }
  }
}

function foldToolCalls(
  raw: Array<{
    id?: unknown
    type?: unknown
    function?: { name?: unknown; arguments?: unknown }
  }>
): Array<{ id: string; name: string; args: string }> {
  const out: Array<{ id: string; name: string; args: string }> = []
  for (const call of raw) {
    if (!call || typeof call !== "object") continue
    const name =
      typeof call.function?.name === "string" ? call.function.name : ""
    if (!name) continue
    out.push({
      id:
        typeof call.id === "string" && call.id ? call.id : `call_${out.length}`,
      name,
      args:
        typeof call.function?.arguments === "string"
          ? call.function.arguments
          : "{}",
    })
  }
  return out
}

/** Loop input → wire message: protocol fields only (reasoning never leaves). */
function toWireMessage(m: AgentPromptMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content }
  if ("name" in m) wire.name = m.name
  if ("tool_call_id" in m) wire.tool_call_id = m.tool_call_id
  if ("tool_calls" in m) wire.tool_calls = m.tool_calls
  return wire
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}
