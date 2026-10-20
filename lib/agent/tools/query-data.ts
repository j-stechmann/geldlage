import type { AgentTool, ToolContext } from "@/lib/agent/types"
import { QUERY_MAX_ROWS } from "@/lib/agent/constants"
import { parseQuery } from "@/lib/agent/query/parse"
import { runQuery } from "@/lib/agent/query/compile"

/**
 * The `query_data` tool (ADR-0034): read-only, freely composable queries
 * over the asking user's own financial data via a flat JSON DSL. Freedom
 * and safety are separated by design: the model picks any table/column/
 * filter/aggregation combination it needs, but every element is matched
 * against the whitelist catalog and compiled to one parameterized SELECT
 * on a SQLite connection opened readonly — there is no field in the DSL
 * that could carry SQL text, and user scoping is compiled in, not asked
 * for. Column tables + DSL rules are appended to the system prompt by
 * queryDataPromptDoc(); this description stays capability-focused.
 */

const conditionSchema = {
  type: "object",
  properties: {
    column: { type: "string" },
    op: {
      type: "string",
      enum: [
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "like",
        "in",
        "isNull",
        "notNull",
      ],
    },
    value: {
      description:
        "Wert passend zur Spalte (String/Integer); bei op in: Array; bei isNull/notNull: Feld weglassen",
    },
  },
  required: ["column", "op"],
  additionalProperties: false,
}

// `as const` on name keeps the literal type so tool-registry's
// AgentToolName union derives from the registry (see get_category_totals).

/**
 * Having items are schema-restricted like the parser restricts them (the
 * generic conditionSchema would advertise ops/value shapes having rejects:
 * only the six numeric comparisons exist, and the value is always a
 * number — isNull/notNull/contains/like/in have no HAVING meaning).
 */
const havingConditionSchema = {
  type: "object",
  properties: {
    column: {
      type: "string",
      description: "Numerischer Aggregate-Alias (z. B. summe_cents)",
    },
    op: {
      type: "string",
      enum: ["eq", "ne", "gt", "gte", "lt", "lte"],
    },
    value: {
      type: "number",
      description:
        "Vergleichszahl (Beträge in Cent, Integer; avg kann Dezimal liefern)",
    },
  },
  required: ["column", "op", "value"],
  additionalProperties: false,
}
export const query_data = {
  name: "query_data" as const,
  description:
    "Liest Finanzdaten des Sitzungsbenutzers über eine JSON-Abfrage (nur Lesen, keine Änderungen). Frei wählbar: Tabelle, Spalten (select), Filter (where/whereAny), Aggregation (aggregate + groupBy + having), Sortierung (orderBy), limit (max 100). Spalten- und Join-Liste steht im System-Prompt; Joined Spalten als „alias.spalte“ (z. B. category.name). Beträge in Cent (Integer, negativ = Ausgabe). Bei Fehlermeldung die Abfrage korrigieren und erneut aufrufen.",
  parameters: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description:
          "Eine erlaubte Tabelle (Liste im System-Prompt), z. B. transactions",
      },
      select: {
        type: "array",
        items: { type: "string" },
        description:
          "Spalten (Basisname oder alias.spalte). Zeilenabfragen immer explizit setzen — ohne select kommen alle Spalten zurück und breite Ergebnisse werden gekürzt.",
      },
      where: {
        type: "array",
        items: conditionSchema,
        description: "UND-verknüpfte Filter",
      },
      whereAny: {
        type: "array",
        items: conditionSchema,
        description:
          "ODER-verknüpfte Filtergruppe (wird UND mit where verknüpft); mind. 2 Bedingungen sinnvoll",
      },
      aggregate: {
        type: "array",
        items: {
          type: "object",
          properties: {
            fn: {
              type: "string",
              enum: ["sum", "count", "avg", "min", "max"],
            },
            column: {
              type: "string",
              description:
                "Spalte; bei sum/avg/min/max Pflicht, bei count optional (ohne: count(*))",
            },
            alias: {
              type: "string",
              description:
                "Ergebnisname (Standard: fn_spalte); für having/orderBy referenzierbar",
            },
          },
          required: ["fn"],
          additionalProperties: false,
        },
        description:
          "Aggregationen (mit groupBy: Gruppierung, ohne: Gesamtwert)",
      },
      groupBy: {
        type: "array",
        items: { type: "string" },
        description: "Gruppierungsspalten (z. B. booking_month)",
      },
      having: {
        type: "array",
        items: havingConditionSchema,
        description:
          "Filter auf Aggregate-Aliase (nur mit aggregate; nur numerische ops eq/ne/gt/gte/lt/lte)",
      },
      orderBy: {
        type: "array",
        items: {
          type: "object",
          properties: {
            column: { type: "string" },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["column"],
          additionalProperties: false,
        },
        description: "Sortierung; Spalte oder Aggregate-Alias",
      },
      limit: {
        type: "integer",
        description: `Maximale Zeilenzahl (1–${QUERY_MAX_ROWS}, Standard 20)`,
      },
    },
    required: ["table"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    const query = parseQuery(args)
    return runQuery(query, ctx.uid)
  },
} satisfies AgentTool
