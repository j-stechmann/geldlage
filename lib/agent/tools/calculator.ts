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
 * arithmetic. expr-eval out of the box also ships a rich non-arithmetic
 * grammar (trig and rounding functions, `random()`, `PI`, comparisons,
 * string concatenation, array indexing) with no way to opt out of the
 * function/constant dictionaries, so the parser is narrowed here to pure
 * arithmetic: the operator options make every non-arithmetic group fail
 * at tokenize time with a clean parse error, and the remaining operator/
 * function/constant dictionaries are pruned so built-in names surface as
 * "undefined variable" errors. What survives is exactly `+ - * / % ^`,
 * parentheses and decimal literals — where `%` is the division remainder
 * (modulo), NOT a percent sign (the tool description says so explicitly,
 * since a model reading "%" as percent would get a plausible but wrong
 * "verified" result). Every failure path throws a descriptive error the
 * executor folds into an `{"error": …}` tool result the model can
 * self-correct from. Non-finite outcomes (division by zero → Infinity
 * under plain JS arithmetic) are rejected too: an infinite "result" would
 * read back as a believable number and would be trusted by the model,
 * exactly what tools exist to prevent.
 */

export interface CalculatorResult {
  /** The expression as received (echoed so the model can verify its own call). */
  expression: string
  result: number
}

/** The only unary operators the narrowed parser keeps (signs only). */
const signUnaryOps = new Set(["-", "+"])

/**
 * expr-eval's typed `operators` option covers operator *groups* only —
 * the function/constant dictionaries and the per-name unary math functions
 * have no opt-out, so the parser instance is additionally pruned. Both
 * mechanisms combined: options give clean tokenize-time errors for the
 * non-arithmetic character operators, pruning removes the rest.
 */
function arithmeticParser(): Parser {
  const parser = new Parser({
    allowMemberAccess: false,
    operators: {
      factorial: false,
      comparison: false,
      concatenate: false,
      conditional: false,
      logical: false,
      in: false,
      assignment: false,
      fndef: false,
      // '[' maps to the undocumented "array" option key (grouping array
      // literals and subscript indexing), absent from the .d.ts interface:
      // disabling it rejects array literals and [index] subscripting clean.
      ...({ array: false } as Record<string, boolean>),
    },
  })
  parser.unaryOps = Object.fromEntries(
    Object.entries(parser.unaryOps).filter(([op]) => signUnaryOps.has(op))
  )
  parser.functions = {}
  parser.consts = {}
  return parser
}

// One shared instance: evaluate() is stateless across calls (parse builds
// a fresh ParserState each time), so rebuilding per call would be waste.
const parser = arithmeticParser()

// `as const` on name keeps the literal type so tool-registry's
// AgentToolName union derives from the registry (a tool declaration with
// `name: string` would silently widen the derived union to string).
export const calculator = {
  name: "calculator" as const,
  description:
    'Rechnet einen arithmetischen Ausdruck aus. Führe jede Zwischenrechnung (z. B. Cent in Euro umrechnen, Beträge aufteilen, Summen oder Prozente bilden) mit diesem Tool aus, statt selbst zu rechnen. Unterstützt + - * / %, Klammern und Dezimalzahlen mit Punkt (kein Komma). Achtung: % ist der Divisionsrest (Modulo), kein Prozentzeichen — Prozente bildest du über Multiplikation/Division. Nur reine Zahlen: keine Funktionen, Variablen, Vergleiche oder Texte. Gib in expression nur den Ausdruck ohne Einheiten oder Erklärung an, z. B. "12890 + 3400".',
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description:
          'Arithmetischer Ausdruck mit Punkt als Dezimaltrennzeichen (kein Komma), z. B. "(12890 + 3400) / 100". % ist der Divisionsrest (Modulo), kein Prozentzeichen.',
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
      result = parser.evaluate(expression)
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
