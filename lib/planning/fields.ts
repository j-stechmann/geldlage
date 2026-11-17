/**
 * One plan-field vocabulary (ADR-0037).
 *
 * The REST validator and the agent tools used to keep two hand-written
 * spellings of the same field set. This table is the single source for the
 * vocabulary, the snake_case aliases and the free-text byte caps; the
 * per-kind validation branches and error messages stay explicit in the
 * service (ADR-0025 — no schema engine).
 *
 * `agentOrder` preserves the agent's allowed-fields message order, which
 * differs from the REST key order (notes last for the model).
 */
import {
  PLAN_STATUSES,
  type PlanInputKey,
  type PlanStatus,
} from "@/lib/contracts/planning"
import { MAX_COUNTERPARTY, MAX_TEXT } from "@/lib/planning/limits"

export type PlanFieldKind =
  "amount" | "date" | "rrule" | "status" | "text" | "reference"

export interface PlanFieldMeta {
  readonly key: PlanInputKey
  readonly agentKey: string
  readonly kind: PlanFieldKind
  readonly errorCode: string
  readonly agentOrder: number
  readonly maxBytes?: number
}

export const PLAN_FIELDS = [
  {
    key: "amountCents",
    agentKey: "amount_cents",
    kind: "amount",
    errorCode: "invalid_amount",
    agentOrder: 1,
  },
  {
    key: "dtstart",
    agentKey: "dtstart",
    kind: "date",
    errorCode: "invalid_dtstart",
    agentOrder: 2,
  },
  {
    key: "rrule",
    agentKey: "rrule",
    kind: "rrule",
    errorCode: "invalid_rrule",
    agentOrder: 3,
  },
  {
    key: "status",
    agentKey: "status",
    kind: "status",
    errorCode: "invalid_status",
    agentOrder: 4,
  },
  {
    key: "counterparty",
    agentKey: "counterparty",
    kind: "text",
    errorCode: "invalid_counterparty",
    agentOrder: 5,
    maxBytes: MAX_COUNTERPARTY,
  },
  {
    key: "purpose",
    agentKey: "purpose",
    kind: "text",
    errorCode: "invalid_purpose",
    agentOrder: 6,
    maxBytes: MAX_TEXT,
  },
  {
    key: "notes",
    agentKey: "notes",
    kind: "text",
    errorCode: "invalid_notes",
    agentOrder: 9,
    maxBytes: MAX_TEXT,
  },
  {
    key: "accountId",
    agentKey: "account_id",
    kind: "reference",
    errorCode: "invalid_reference",
    agentOrder: 7,
  },
  {
    key: "categoryId",
    agentKey: "category_id",
    kind: "reference",
    errorCode: "invalid_reference",
    agentOrder: 8,
  },
] as const satisfies readonly PlanFieldMeta[]

/** REST vocabulary in the validator's message order. */
export const PLAN_INPUT_KEYS: ReadonlySet<string> = new Set(
  PLAN_FIELDS.map((f) => f.key)
)

export const PLAN_AGENT_FIELD_MAP: Readonly<Record<string, PlanInputKey>> =
  Object.fromEntries(PLAN_FIELDS.map((f) => [f.agentKey, f.key]))

/** Agent vocabulary in the model-facing message order. */
export const PLAN_AGENT_KEYS: readonly string[] = [...PLAN_FIELDS]
  .sort((a, b) => a.agentOrder - b.agentOrder)
  .map((f) => f.agentKey)

export function planTextLimit(
  key: "counterparty" | "purpose" | "notes"
): number {
  const spec = PLAN_FIELDS.find((f) => f.key === key)
  return spec && "maxBytes" in spec ? spec.maxBytes : MAX_TEXT
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return (PLAN_STATUSES as readonly unknown[]).includes(value)
}
