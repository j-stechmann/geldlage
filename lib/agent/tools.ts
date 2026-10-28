/**
 * Agent tool barrel (ADR-0033): keeps the historical import surface
 * (lib/agent/tools) stable while the implementation is split —
 * lib/agent/tools/* for the concrete tools, lib/agent/tool-registry.ts
 * for the registry array and OpenAI wire translation.
 */

export {
  agentTools,
  toolByName,
  toolsForRequest,
  type AgentToolName,
} from "@/lib/agent/tool-registry"

export {
  get_category_totals,
  periodStartDate,
  periodEndDate,
  type CategoryTotalsPeriod,
  type CategoryTotalsStatus,
  type CategoryTotalsResult,
} from "@/lib/agent/tools/category-totals"

export { query_data } from "@/lib/agent/tools/query-data"

export { calculator, type CalculatorResult } from "@/lib/agent/tools/calculator"

export { list_plans } from "@/lib/agent/tools/list-plans"

export { create_plan } from "@/lib/agent/tools/create-plan"

export { update_plan } from "@/lib/agent/tools/update-plan"

export { delete_plan } from "@/lib/agent/tools/delete-plan"

export {
  PLAN_LIST_MAX,
  type AgentPlanSummary,
  type AgentPlanView,
} from "@/lib/agent/tools/plan-shared"
