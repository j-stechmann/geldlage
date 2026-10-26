import type { AgentTool } from "@/lib/agent/types"
import { deletePlan } from "@/lib/planning/service"
import { planIdFromArgs } from "./plan-shared"

/**
 * The `delete_plan` tool (ADR-0036): hard delete over the exact
 * deletePlan service function the DELETE /api/plans/[id] route calls.
 * Plans are a leaf table — nothing references them (ADR-0035), so the
 * delete can never disturb the bank-truth core; the guardrail is
 * behavioral, not mechanical: the system prompt makes the model resolve
 * ids via list_plans/query_data first, confirm in chat before deleting,
 * and prefer `status: finished` for mere completion (no two-phase
 * confirm token — the only caller is its own model, which would simply
 * set any confirmation flag anyway).
 */

export const delete_plan = {
  name: "delete_plan" as const,
  description:
    "Löscht einen Plan endgültig und unwiderruflich (Datensatz samt zukünftiger Termine weg). Pflicht: id — ermittele sie immer zuerst über list_plans oder query_data, erfinde niemals eine ID. Lösche nur auf ausdrücklichen Wunsch und frage vorher kurz nach; zum nur-Beenden/Erledigt-Markieren eines Plans nutze stattdessen update_plan mit status „finished“. Erfolg: {deleted: true, id}; unbekannte oder fremde id: Fehler not_found.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Plan-ID (UUID) aus list_plans, create_plan oder einer query_data-Abfrage auf planned_transactions.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx): Promise<unknown> {
    const id = planIdFromArgs(args ?? null)
    const deleted = deletePlan(ctx.uid, id)
    if (!deleted) {
      throw new Error(
        "not_found: no plan with this id (look up ids via list_plans or query_data first)"
      )
    }
    return { deleted: true, id }
  },
} satisfies AgentTool
