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
} from "@/lib/agent/tool-registry"

export {
  get_category_totals,
  periodStartDate,
  periodEndDate,
  type AgentToolName,
  type CategoryTotalsPeriod,
  type CategoryTotalsResult,
} from "@/lib/agent/tools/category-totals"
