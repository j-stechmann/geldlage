import { toolByName } from "@/lib/agent/tools"
import type { ToolContext } from "@/lib/agent/types"

/**
 * Tool execution with full error absorption (ADR-0033): parse errors,
 * unknown tools and thrown tool errors all become JSON error objects —
 * the loop never throws on tool misbehavior (stream errors DO propagate,
 * those are infrastructure, not model mistakes). Split from loop.ts so the
 * error-absorption contract lives with the code that owns it while the
 * loop stays a pure turn state machine.
 */

/**
 * Executes one tool call and serializes the result for the tool message.
 * Every failure mode (unknown tool, unparseable args, thrown tool error)
 * degrades to a JSON `{"error": …}` result string so the model sees the
 * problem and can self-correct on the next round.
 */
export async function executeToolCall(
  name: string,
  rawArgs: string,
  ctx: ToolContext
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
