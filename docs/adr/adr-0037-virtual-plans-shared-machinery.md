# ADR-0037: Virtual plans, shared read machinery

_Status: accepted · Date: 2026-11-17_

## Context

[ADR-0035](adr-0035-planned-transactions-rrule.md) deliberately built planned
transactions as a separate stack: a `planned_transactions` table, its own
service, its own routes and its own UI. That isolation protects the
bank-truth core (dedupe, learned rules, snapshot anchors) and remains
correct — occurrences must never be materialized into `transactions`.

The isolation also let the planning feature grow a parallel copy of machinery
the transaction side already owned:

- hand-written server/client DTOs (`PlanRow`, `PlanOccurrence`,
  `TransactionPage`, `TxRow`, `CalendarTransaction`); the planned-only
  `ForecastResult` was later removed by
  [ADR-0038](adr-0038-automatic-daily-prediction.md);
- calendar-window and `accountId` validation copied into three routes, with
  the transactions calendar importing its window caps from the planning
  service (an inverted dependency);
- pagination parsing duplicated (and the transactions route lacked the plans
  route's unsafe-OFFSET guard);
- ISO date and month helpers reimplemented (`isoDatePlus`/`isoShift`/
  `dayDiff`, two `lastDayOfMonth`s, `monthOffset`);
- the forecast reimplemented `latestAnchor` and the time-scoped booked
  predicate already in `lib/analytics/engine.ts`;
- two greedy 1:1 pairing loops, two transaction→plan prefill functions, two
  plan-field vocabularies, and duplicated pager/debounce/category-badge code.

## Decision

Keep the virtuality invariant and share every reusable concern:

1. **Single-source contracts.** `lib/contracts/planning.ts` and
   `lib/contracts/transactions.ts` (client-safe: types plus the status
   vocabulary) are the one declaration of the wire DTOs. `PlanStatus` lives
   there; the schema imports and re-exports it. Client/server drift becomes a
   compile error rather than a runtime surprise.

2. **Shared date and query-parameter helpers.** `lib/dates.ts` owns ISO/local
   date arithmetic, keeping the original invalid-input contracts
   (`isoDatePlus` throws, `isoShift` returns `""`, `dayDiff` returns `NaN`);
   the month-series helpers additionally reject values that are neither a real
   `YYYY-MM` key nor a real `YYYY-MM-DD` date (the forecast and engine pass
   full dates).
   `lib/api/query.ts` owns the digits-only account/month parsing, the lenient
   page-number parsing and the calendar window caps and precedence shared by
   both calendar reads. The OFFSET-overflow guard lives in
   `lib/pagination.ts` (see 4); the window caps sit beside `parseWindow`, so
   the bank calendar no longer imports anything from `lib/planning/`.

3. **Shared balance machinery, separate scopes.** `lib/analytics/balance.ts`
   owns `latestAnchor` (the deterministic snapshot tie-break is its
   `snapshot_date, created_at, id` descending SQL order); the generic
   user/account/status/date WHERE scaffold lives in `lib/analytics/scope.ts`
   (`buildTransactionScope`). `buildTimeScopedWhere` is the booked-only
   predicate delegating to that scaffold. The engine and the forecast import
   the same implementation. The flow, time-scoped and forecast scopes remain
   distinct (ADR-0022); the builders never accept `TransactionFilters`, and
   each scope supplies its own status predicate.

4. **Generic plumbing, domain predicates local.** `lib/pagination.ts` owns
   count/offset/pageCount and the unrepresentable-OFFSET guard; `lib/greedy.ts`
   owns the sort-and-consume-once pairing loop. Plans and transactions keep
   their own row projections, WHERE builders and matching viability
   predicates.

5. **One plan field vocabulary.** `lib/planning/fields.ts` is the single
   source for the plan field names, snake_case aliases and text byte caps.
   Per-field validation logic and error messages stay explicit in the service
   (ADR-0025 — no schema engine), and the agent's message order is preserved
   separately from the REST order.

6. **One movement mapping.** `lib/transactions.ts` owns the
   counterparty-by-direction rule; `lib/planning/prefill.ts` maps a
   transaction-like movement onto the plan dialog prefill. The calendar chip
   read moves into `lib/analytics/queries.ts` with its own explicit
   booked-and-pending status list passed to the shared
   `buildTransactionScope` scaffold — it is not routed through the flow-scope
   `buildWhere`.

7. **Shared UI plumbing.** `components/pager.tsx`,
   `components/category-badge.tsx` and `hooks/use-debounced-search.ts` replace
   the duplicated table/list pieces; callers keep their own copy and states.

## Explicit non-goals

- No schema change, no `kind` flag, no materialized occurrences, no persisted
  matches. `planned_transactions` stays virtual (ADR-0035).
- Do not merge the three analytics scopes; sharing the WHERE scaffold
  (`buildTransactionScope`) is the implementation limit. Status predicates and
  result projections stay scope-specific.
- Do not use the flow-scope `buildWhere` for the calendar chip query.
- Do not merge `PlanRow` with `TransactionRow`, or `CalendarTransaction` with
  `TransactionRow` — the projections differ deliberately.
- Do not merge the plan-matching and import-reconcile viability predicates.
- Do not merge the REST plan DTO with the agent's size-budgeted snake_case
  view, and do not generate the agent tool schemas from the field table.
- Do not unify JSON-body id normalization with query-param parsing.
- Do not unify the plans' 20-row and transactions' 25-row page-size defaults.

## Consequences

- Positive: one implementation per shared concern; drifting DTOs, param
  contracts, anchor math and UI copy become compile/test failures. The
  transactions calendar no longer depends on the planning service or its
  limits, and the forecast uses the same anchor rule as the balance KPI by
  construction.
- Positive: the transaction list gains the plans route's unsafe-OFFSET guard
  (an absurd page answers an empty page echoing the requested number instead
  of a SQLite binding error; a page above 2^53 whose OFFSET is still a valid
  int64 is queried and simply matches no rows).
- Negative: a small amount of coupling between planning and the transaction
  read layer; the contracts module must stay import-safe for clients, and the
  shared parameter/date helpers must preserve their original edge semantics.
- Neutral: response shapes and defaults are unchanged and the existing
  route/UI tests remain the integration guard. The intentional validation,
  paging and window-precedence changes are listed in the PR and in
  [api.md](../api.md) / [planning.md](../planning.md).

## References

- `lib/contracts/`, `lib/dates.ts`, `lib/api/query.ts`, `lib/pagination.ts`,
  `lib/greedy.ts`, `lib/analytics/balance.ts`, `lib/analytics/scope.ts`,
  `lib/planning/fields.ts`, `lib/transactions.ts`, `lib/planning/prefill.ts`
- [ADR-0035](adr-0035-planned-transactions-rrule.md) (virtual plans),
  [ADR-0036](adr-0036-agent-plan-write-tools.md) (plan service boundary),
  [ADR-0022](adr-0022-balance-back-calculation.md) (analytics scopes),
  [ADR-0025](adr-0025-manual-api-validation.md) (hand-rolled validation)
