import type { AgentTool } from "@/lib/agent/types"
import { get_category_totals } from "@/lib/agent/tools/category-totals"

/**
 * OpenAI wire-format translation for the agent tool registry (ADR-0033):
 * the registry array is the single source of truth — the wire `tools`
 * array for the chat endpoint derives from it. Adding a tool is one entry
 * below (name, description, JSON-schema parameters, `execute`). Kept
 * separate from the implementations (lib/agent/tools/*) so wire concerns
 * (what llama-server rejects, e.g. `tools: []` on some builds) don't mix
 * with tool logic.
 */

/**
 * Ordered registry — the only place tools are listed. Extending it
 * automatically extends toolsForRequest() and the system prompt's tool
 * list.
 */
export const agentTools: AgentTool[] = [get_category_totals]

export function toolByName(name: string): AgentTool | undefined {
  return agentTools.find((t) => t.name === name)
}

/**
 * OpenAI wire-format `tools` array for the chat endpoint. Built from the
 * registry each call (cheap): registry additions need no edit here. An
 * empty registry must produce an empty array — the chat client then omits
 * the field entirely (llama-server rejects `tools: []` on some builds).
 */
export function toolsForRequest(): Array<{
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}> {
  return agentTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}
