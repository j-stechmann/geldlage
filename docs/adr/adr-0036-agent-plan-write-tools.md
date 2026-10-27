# ADR-0036: Agent write tools for plans — first mutable domain (plan CRUD)

_Status: Accepted · Date: 2026-10-26_

## Context

[ADR-0033] shipped the agent's tool registry with one standing rule: **all
tools are read-only**. [ADR-0034] then built the broad read surface
(`query_data`) — its catalog already exposes `planned_transactions`, so
the chat can _report_ what a user planned, but it cannot _do_ anything:
"lege eine monatliche Miete von 850 € an" dead-ends in advice to open the
form by hand. Meanwhile the planning feature ([ADR-0035]) introduced a
clean write boundary that the HTTP routes are thin wrappers around:
user-scoped `createPlan / updatePlan / deletePlan` in
[lib/planning/service.ts](../../lib/planning/service.ts) with
`validatePlanInput` (integer-cents CHECK, RRULE allowlist + ≥ 1
occurrence, ownership of account/category references,
`PlanValidationError` codes). Plans are also a deliberately _virtual_
domain: no other table references them, and occurrences never enter
`transactions` — mutating a plan cannot disturb the bank-truth invariants
(dedupe [ADR-0006], learned rules, snapshot anchors).

## Decision

1. **Four registry tools, one per operation** — `list_plans`,
   `create_plan`, `update_plan`, `delete_plan`. Small, flat schemas beat
   one `manage_plans(action…)` union tool: the local model ([ADR-0012])
   gets focused contracts, and per-field validation errors name the
   operation's own schema. The registry array stays the single source of
   truth ([ADR-0033]) — four entries; the wire `tools` array and the
   prompt's tool list derive automatically.

2. **Thin adapters over the exact service functions — no HTTP detour, no
   second validation.** Each tool calls `createPlan`/`updatePlan`/
   `deletePlan`/`listPlans` with `ctx.uid` (speaker scoping, [ADR-0033]),
   so the REST route and the tool cannot drift: one validation
   implementation, one error taxonomy. `PlanValidationError` is re-thrown
   as `code: message` (the same codes the REST answers carry) and the
   executor's error absorption folds it into a self-correctable
   `{"error": …}` tool result.

3. **snake_case is the tool surface, in both directions.** Args
   (`amount_cents`, `dtstart`, `account_id`, …) and results (including the
   computed `next_due_date`) match the query DSL's DB-column naming
   reality; the tools map to the service's camelCase input keys while
   preserving its key-presence patch semantics (only provided keys change;
   explicit `null` clears a clearable field). Unknown arg keys are
   rejected loudly — the service would silently ignore them, and a
   silently ignored field could read back to the model as a successful
   mutation it trusts.

4. **Money contract unchanged** ([ADR-0002]): integer cents, never 0,
   negative = Ausgabe. Tool descriptions make the € → cents conversion an
   explicit `calculator` step, extending the existing anti-hallucination
   contract to numbers the model writes _into_ the data.

5. **`list_plans` because `query_data` cannot compute "next due".** The
   DSL is a readonly SELECT — RRULE expansion against today is out of its
   reach. `list_plans` returns compact summaries (capped at
   `PLAN_LIST_MAX = 15` rows plus a serialized-char budget that stops
   adding rows before the payload would exceed the ~4000-char
   tool-result cap (truncateToolResult cuts mid-JSON) — long free texts
   can legitimately shrink the list; `limited`/`total` flags point the
   model at `query_data` for anything wider)
   plus `next_due_date`. Unknown args are rejected
   like on the writers: it takes no arguments, and a silently accepted
   filter attempt (e.g. `{"status": "active"}`) would hand back the
   unfiltered list, which the model could report as a filtered result.

6. **Deletes stay prompt-guarded, not token-guarded.** The system prompt
   gains a plan block (registry-gated on `list_plans`, so the rules load
   exactly when the model can act on them): resolve ids via
   `list_plans`/`query_data` first (never invent a UUID), confirm in chat
   before `delete_plan`, prefer `update_plan` with `status: "finished"`
   for mere completion, and briefly report every mutation. No two-phase
   confirm flag: the only caller is the model itself — a confirmation
   boolean would just be set by the thing it is meant to guard against.

7. **Scope stays one domain.** `query_data` remains read-only (readonly
   SQLite connection, [ADR-0034]); transactions, accounts, categories and
   the import/labelling machinery are not tool-reachable for writes. The
   next write domain, if ever, needs its own evaluation — plans earned
   this one service-level validation, user scoping, and leaf-table
   semantics all in place.

## Consequences

- ADR-0033's "all tools are read-only" is superseded _for this domain_
  (this ADR); the read tools' posture is unchanged.
- The system prompt's persona broadens from analysis to also cover planned
  transactions, and the plan rules block appears whenever the quartet is
  advertised.
- The chat can now actually maintain plans: create (one-off or RRULE),
  patch single fields, pause/finish, delete — with `/planung` reflecting
  every change on its next fetch (virtual plans, no data touched beyond
  `planned_transactions`).
- Tests live in `tests/agent-plan-tools.test.ts` (validation-error
  passthrough incl. cross-user isolation, patch semantics, capped
  summaries, registry/prompt wiring).

## References

- lib/agent/tools/plan-shared.ts, list-plans.ts, create-plan.ts,
  update-plan.ts, delete-plan.ts; lib/agent/tool-registry.ts;
  lib/agent/system-prompt.ts
- tests/agent-plan-tools.test.ts — per-tool behavior, uid isolation,
  error passthrough, registry + prompt integration
- [ADR-0033] tool loop, registry, error absorption, uid scoping ·
  [ADR-0034] readonly query DSL (the read half of plan access) ·
  [ADR-0035] plan service semantics (CRUD, validation, virtuality) ·
  [ADR-0002] integer cents
