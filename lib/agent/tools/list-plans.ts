import type { AgentTool } from "@/lib/agent/types"
import { listPlans } from "@/lib/planning/service"
import { assertNoArgs, planSummaries } from "./plan-shared"

/**
 * The `list_plans` tool (ADR-0036): the R of the plan quartet where the
 * query DSL (ADR-0034) falls short — `next_due_date` is a computed value
 * (RRULE expansion against today's local date), which `query_data`'s
 * readonly SELECT cannot produce. Returns compact, capped summaries
 * (plan-shared.ts planSummaries) so the ~4000-char tool-result cap holds;
 * for filtering/aggregation over plans the model keeps using
 * `query_data` (planned_transactions is in the catalog), for full single
 * rows the mutations return planView.
 */

export const list_plans = {
  name: "list_plans" as const,
  description:
    "Listet alle Pläne (geplante Transaktionen) des Sitzungsbenutzers auf, neueste zuerst, als kompakte Zusammenfassungen inkl. next_due_date (nächster Termin heute oder später; null für finished bzw. abgelaufene Einmalpläne) — genau das kann query_data nicht berechnen. Maximal 15 Einträge (limited: true + total, falls es mehr sind). Für Filter, Aggregation oder vollständige Felder (notes, purpose) nutze query_data mit der Tabelle planned_transactions.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(args: unknown, ctx): Promise<unknown> {
    assertNoArgs(args)
    return planSummaries(listPlans(ctx.uid))
  },
} satisfies AgentTool
