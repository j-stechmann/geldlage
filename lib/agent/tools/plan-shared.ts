import {
  nextDueDate,
  PlanValidationError,
  type PlanRow,
} from "@/lib/planning/service"
import { todayLocal } from "@/lib/analytics/date"

/**
 * Shared plan-tool plumbing (ADR-0036): the four plan tools (list_plans,
 * create_plan, update_plan, delete_plan) render one snake_case view of the
 * planning service's PlanRow. The model's naming reality is the query DSL's
 * (ADR-0034 exposes `planned_transactions` with its snake_case DB column
 * names), so a camelCase tool surface would force the model to track two
 * spellings of the same fact; every tool maps its snake_case args to the
 * service's camelCase input keys instead. Mutations return the full view
 * of the affected plan; the list returns compact summaries bounded for the
 * ~4000-char tool-result cap (truncateToolResult).
 */

/** Full model-facing plan view (single-row results: create/update). */
export interface AgentPlanView {
  id: string
  account_id: number | null
  account_name: string | null
  counterparty: string | null
  purpose: string | null
  amount_cents: number
  category_id: number | null
  category_name: string | null
  dtstart: string
  rrule: string | null
  status: string
  notes: string | null
  created_at: string
  updated_at: string
  /**
   * Next occurrence at-or-after today (local calendar), null for finished
   * plans and lapsed one-offs — the same computed field the plans REST
   * list serves as nextDueDate.
   */
  next_due_date: string | null
}

/** Compact model-facing summary (list_plans rows). Notes excluded — the */
/** full view of a mutation or one query_data lookup carries them. */
export interface AgentPlanSummary {
  id: string
  account_id: number | null
  account_name: string | null
  counterparty: string | null
  purpose: string | null
  amount_cents: number
  category_id: number | null
  category_name: string | null
  dtstart: string
  rrule: string | null
  status: string
  next_due_date: string | null
}

/**
 * list_plans entry cap: a summary is ≈250 chars, so 15 stay inside the
 * tool-result cap even with padded texts; more plans arrive as
 * `limited: true` + `total` and the model narrows via query_data.
 */
export const PLAN_LIST_MAX = 15

/** Char cap per free-text summary cell (counterparty, purpose). */
const SUMMARY_TEXT_CHARS = 60

export function planView(plan: PlanRow): AgentPlanView {
  return {
    id: plan.id,
    account_id: plan.accountId,
    account_name: plan.accountName,
    counterparty: plan.counterparty,
    purpose: plan.purpose,
    amount_cents: plan.amountCents,
    category_id: plan.categoryId,
    category_name: plan.categoryName,
    dtstart: plan.dtstart,
    rrule: plan.rrule,
    status: plan.status,
    notes: plan.notes,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    next_due_date: nextDueDate(plan, todayLocal()),
  }
}

/** Newest-first capped summaries + counting flags for the capped rest. */
export function planSummaries(rows: PlanRow[]): {
  plans: AgentPlanSummary[]
  total: number
  limited: boolean
} {
  const sliced = rows.slice(0, PLAN_LIST_MAX)
  return {
    plans: sliced.map((plan) => ({
      id: plan.id,
      account_id: plan.accountId,
      account_name: plan.accountName,
      counterparty: clipText(plan.counterparty),
      purpose: clipText(plan.purpose),
      amount_cents: plan.amountCents,
      category_id: plan.categoryId,
      category_name: plan.categoryName,
      dtstart: plan.dtstart,
      rrule: plan.rrule,
      status: plan.status,
      next_due_date: nextDueDate(plan, todayLocal()),
    })),
    total: rows.length,
    limited: rows.length > PLAN_LIST_MAX,
  }
}

function clipText(s: string | null): string | null {
  if (s === null || s.length <= SUMMARY_TEXT_CHARS) return s
  // keep surrogate pairs intact: never cut between a high and a low surrogate
  let cut = SUMMARY_TEXT_CHARS - 1
  const high = s.charCodeAt(cut - 1)
  const low = s.charCodeAt(cut)
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
    cut -= 1
  }
  return s.slice(0, cut) + "…"
}

/**
 * Tool args (snake_case) → planning-service input keys (camelCase, the
 * key-presence- driven patch semantics of validatePlanInput). Unknown keys
 * throw loudly: the service would silently ignore them, and a silently
 * ignored field (e.g. a typo'd amount) could read back as a successful
 * mutation the model trusts.
 */
const PLAN_FIELD_MAP = {
  amount_cents: "amountCents",
  dtstart: "dtstart",
  rrule: "rrule",
  status: "status",
  counterparty: "counterparty",
  purpose: "purpose",
  account_id: "accountId",
  category_id: "categoryId",
  notes: "notes",
} as const

export function planInputFromArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    const mapped = (PLAN_FIELD_MAP as Record<string, string>)[key]
    if (mapped === undefined) {
      throw new Error(
        `unknown field: ${key} (allowed fields: ${Object.keys(PLAN_FIELD_MAP).join(", ")})`
      )
    }
    input[mapped] = value
  }
  return input
}

/** Parsed tool args must be a JSON object (never a bare array/scalar). */
export function assertArgsObject(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("invalid args")
  }
  return args as Record<string, unknown>
}

/**
 * list_plans takes NO arguments (its schema's properties is empty) — but the
 * model may still pass a key ({"status": "active"} is plausible given how
 * prominent status is across the other plan tools). Silent acceptance would
 * return the UNFILTERED list, which reads back as "your active plans" — the
 * same silently-ignored-field failure planInputFromArgs rejects loudly on
 * the write side. Plain calls stay valid: the executor folds a missing args
 * JSON into {}, and null/undefined count as no args as well.
 */
export function assertNoArgs(args: unknown): void {
  if (args === null || args === undefined) return
  assertArgsObject(args)
  const keys = Object.keys(args)
  if (keys.length > 0) {
    throw new Error(
      `unknown field${keys.length > 1 ? "s" : ""}: ${keys.join(", ")} (list_plans takes no arguments)`
    )
  }
}

/**
 * Extracts and validates the plan id from update/delete args — presence
 * and stringness only (the service resolves anything else as not_found,
 * which the tool surfaces with the id-lookup hint).
 */
export function planIdFromArgs(args: unknown): string {
  const raw = assertArgsObject(args)
  const id = raw.id
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("invalid args: id (string) is required")
  }
  return id.trim()
}

/**
 * Re-throws a PlanValidationError as `code: message` so the model sees
 * the machine code (the same code the REST answers carry) AND the human
 * hint, and can self-correct from either; other errors propagate
 * unchanged (executor folds any throw into a `{"error": …}` result).
 */
export function rethrowPlanError(err: unknown): never {
  if (err instanceof PlanValidationError) {
    throw new Error(`${err.code}: ${err.message}`)
  }
  throw err
}
