/**
 * Shared types of the agent chat core (ADR-0033): the tool registry shape,
 * the loop's event protocol (streamed to the client as SSE and used by the
 * route for persistence) and the message shape exchanged with the chat
 * endpoint. Kept dependency-free so tests and the route can import types
 * without pulling in the LLM client.
 */

/** Everything a tool needs besides its args: the asking user's id. */
export interface ToolContext {
  uid: number
}

/**
 * One agent tool. `parameters` is the JSON Schema sent to llama-server
 * (OpenAI wire format); `execute` receives the already-parsed model args
 * and returns a plain serializable value (JSON.stringify'd into the tool
 * result by the loop).
 */
export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: unknown, ctx: ToolContext): Promise<unknown>
}

/**
 * Loop events, in emission order: reasoning/content fragments stream
 * through unchanged, tool_call/tool_result bracket one execution,
 * `done` closes the turn. `done` carries the accumulated content+reasoning
 * so the route persists exactly once after the loop finishes; `messageId`
 * is always null here — the route fills it after inserting the assistant
 * message (the loop is persistence-free by design).
 */
export type AgentLoopEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string }
  | {
      type: "done"
      messageId: string | null
      content: string
      reasoning: string | null
    }

/**
 * Conversation message in the OpenAI chat-completions shape. Tool rounds
 * need the full protocol trio: the assistant message carrying `tool_calls`,
 * the per-call `tool` messages keyed by `tool_call_id`, and user messages.
 * `reasoning` is display/persistence metadata only — it never leaves the
 * loop, the request builder drops it (see lib/agent/chat-client.ts).
 */
export interface AgentChatMessage {
  role: "user" | "assistant" | "tool"
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  reasoning?: string | null
}

/**
 * Loop-internal system message: never stored, never windowed, never
 * carried in AgentChatMessage history (the store's role CHECK admits only
 * user/assistant/tool).
 */
export interface AgentSystemMessage {
  role: "system"
  content: string
}

/** What the chat endpoint accepts per request: history plus the system turn. */
export type AgentPromptMessage = AgentChatMessage | AgentSystemMessage
