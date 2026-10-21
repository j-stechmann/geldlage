import { Parser } from "expr-eval"
import type { AgentTool } from "@/lib/agent/types"

/**
 * The `calculator` tool (ADR-0033): evaluates one arithmetic expression
 * the model writes. Derived numbers (cent→euro conversion, subtotal
 * splitting, percentage arithmetic) happen in a verified evaluator
 * instead of the model's prose — the same anti-hallucination contract as
 * the data tools, extended to math on numbers the model itself computed
 * in-between tool rounds.
 *
 * Stateless and user-independent: no money data flows through it, so the
 * `ctx.uid` scoping of the other tools is a no-op here (the parameter
 * exists only because the shared AgentTool interface demands it).
 *
 * Evaluation goes through expr-eval's own recursive-descent parser — not
 * eval()/Function — so a model-generated string stays inert beyond
 * arithmetic; variables and functions are rejected by the parser. Every
 * failure path throws a descriptive error the executor folds into an
 * `{"error": …}` tool result the model can self-correct from. Non-finite
 * outcomes (division by zero → Infinity under plain JS arithmetic) are
 * rejected too: an infinite "result" would read back as a believable
 * number and would be trusted by the model, exactly what tools exist to
 * prevent.
 */

export interface CalculatorResult {
  /** The expression as received (echoed so the model can verify its own call). */
  expression: string
  result: number
}

// `as const` on name keeps the literal type so tool-registry's
// AgentToolName union derives from the registry (a tool declaration with
// `name: string` would silently widen the derived union to string).
export const calculator = {
  name: "calculator" as const,
  description:
    'Rechnet einen arithmetischen Ausdruck aus. Führe jede Zwischenrechnung (z. B. Cent in Euro umrechnen, Beträge aufteilen, Summen oder Prozente bilden) mit diesem Tool aus, statt selbst zu rechnen. Unterstützt + - * / %, Klammern und Dezimalzahlen mit Punkt (kein Komma). Gib in expression nur den Ausdruck ohne Einheiten oder Erklärung an, z. B. "12890 + 3400".',
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description:
          'Arithmetischer Ausdruck mit Punkt als Dezimaltrennzeichen (kein Komma), z. B. "(12890 + 3400) / 100".',
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  async execute(args: unknown): Promise<unknown> {
    const raw = (args ?? null) as { expression?: unknown } | null
    const expression = raw?.expression
    if (typeof expression !== "string" || expression.trim().length === 0) {
      throw new Error("invalid args")
    }

    let result: number
    try {
      result = new Parser().evaluate(expression)
    } catch (err) {
      throw new Error(
        `invalid expression: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (!Number.isFinite(result)) {
      throw new Error(`invalid expression: not a finite number`)
    }

    const out: CalculatorResult = { expression, result }
    return out
  },
} satisfies AgentTool
