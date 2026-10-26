# Planning (geplante Transaktionen)

Future money, planned by hand: the `/planung` page manages **virtual
plans** — recurring (full RFC 5545 RRULE) or one-off — renders their
occurrences on a calendar, checks them off against real bookings, and
projects the balance. Implemented per
[ADR-0035](adr/adr-0035-planned-transactions-rrule.md); the design invariant
is _not touching a single line of the analytics/import/labelling core_:
plans are virtual, matching is read-time, the forecast is its own endpoint.

## Data model

One new table `planned_transactions`
([lib/db/schema.ts](../lib/db/schema.ts), DDL in
[lib/db/index.ts](../lib/db/index.ts)):

| Column         | Type       | Notes                                                                                  |
| -------------- | ---------- | -------------------------------------------------------------------------------------- |
| `id`           | TEXT PK    | UUID                                                                                   |
| `user_id`      | INTEGER FK | owning user — plans are per user like every domain table                               |
| `account_id`   | INTEGER FK | nullable: NULL = plan applies to "any account" (visible under the account filter tool) |
| `counterparty` | TEXT       | free text; drives the match ("Mietwerk GmbH")                                          |
| `purpose`      | TEXT       | free text                                                                              |
| `amount_cents` | INTEGER    | signed cents ([ADR-0002](adr/adr-0002-integer-cents.md)); CHECK `<> 0`                 |
| `category_id`  | INTEGER FK | nullable                                                                               |
| `dtstart`      | TEXT       | first occurrence, ISO `YYYY-MM-DD`                                                     |
| `rrule`        | TEXT       | bare RFC 5545 RRULE value, allowlisted (below); **NULL = one-off on `dtstart`**        |
| `status`       | TEXT       | `active / paused / finished` (CHECK enforced; paused still expands, finished doesn't)  |
| `notes`        | TEXT       |                                                                                        |

Indexes: `planned_transactions_user_status_idx` `(user_id, status)` and
`planned_transactions_account_idx` `(account_id)`.

## Recurrence (`lib/planning/recurrence.ts`)

- **Validation before storage** ([ADR-0035](adr/adr-0035-planned-transactions-rrule.md)):
  `FREQ ∈ {DAILY, WEEKLY, MONTHLY, YEARLY}`; parts allowlist
  `INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/BYMONTH/BYSETPOS/WKST`;
  `INTERVAL 1–100`, `COUNT 1–366`; multi-line texts and `DTSTART:`/`EXDATE:`/
  `RDATE:`-carrying inputs rejected. Ordinal (numeric) `BYDAY` values
  (`1FR`, `-1SU`) are rejected for DAILY/WEEKLY — RFC-invalid, and rrule
  silently _ignores_ the ordinal there. Canonical stored form is rrule's
  serialization (no `RRULE:` prefix; `+1FR` ordinals normalized to `1FR`).
- **Expansion**: `expandOccurrenceDates(dtstart, rrule, {from, to}, cap)`.
  Every rule is rebuilt with an **explicit dtstart** — `rrulestr` alone
  defaults `dtstart` to _now_ and would silently empty pre-today windows.
  Dates anchor at **noon UTC** (`Date.UTC(y, m-1, d, 12)`) so DST never
  shifts a day and month ends behave; ISO strings are read from UTC parts.
- **RRULE semantics are RRULE's**: monthly `BYMONTHDAY=31` _skips_ short
  months (a bank debit would clamp to Feb 28). The create/edit form shows a
  hint when day ≥ 29 is chosen for monthly rules.
- `nextOccurrenceDate` powers the list's "Nächster Termin"; both are
  capped, so unbounded rules can never scan forever.

## Occurrence matching (`lib/planning/matching.ts`)

Read-time, deterministic greedy 1:1 (same pairing style as the import
reconcile, [ADR-0007](adr/adr-0007-fuzzy-reconciliation.md)):

| Rule         | Value                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidates   | booked (`Gebucht`) rows of the user, in `[window.from − 5 d, window.to + 7 d]`, padded by the tolerances below — deliberately NOT `Nicht gebucht` rows: a plan check-off means the money is IN the account |
| Sign         | transaction must carry the **same sign** as the plan                                                                                                                                                       |
| Date         | `tx − occ ∈ [−5, +7]` days (`MATCH_DAYS_BEFORE`/`MATCH_DAYS_AFTER`)                                                                                                                                        |
| Amount       | within `max(500 ct, 1 %)` of the planned amount (`AMOUNT_TOLERANCE_FLOOR_CENTS`/`AMOUNT_TOLERANCE_PCT`)                                                                                                    |
| Counterparty | when the plan names one: normalized, case-insensitive substring against payer/payee; otherwise unconstrained                                                                                               |
| Account      | plan with `account_id` only matches rows of that account; NULL = any                                                                                                                                       |
| Assignment   | sorted by `\|date offset\|`, then `\|amount diff\|`, then tx id; each side consumed once                                                                                                                   |

Result states, derived per request — **no storage** (changing/deleting a
plan can never leave stale matches behind, [ADR-0019](adr/adr-0019-live-batch-counters.md)
spirit): `erwartet` (future, unmatched), `überfällig` (past due, unmatched),
`gebucht` (matched, ✓).

## Forecast (`lib/planning/service.ts` → `GET /api/plans/forecast`)

The **third analytics scope** (flow / time-scoped /
planned): [ADR-0022](adr/adr-0022-balance-back-calculation.md)'s
two-scope invariant in [lib/analytics/engine.ts](../lib/analytics/engine.ts)
is left untouched; the forecast endpoint is deliberately separate.

- **Starting balance** = latest snapshot anchor (date ≤ today) + Σ booked
  `(snapshot, today]`; no snapshot → Σ booked ≤ today, flagged
  `withoutSnapshot`. Account filter respected like the balance timeline.
- **Planned aggregates use only UNMATCHED occurrences** from today through
  `months` (clamped 1–60, default 12): matched ones are booked money
  already inside the actuals — including them would double-count. Also
  included in the _balance projection_ (but not the planned sums): booked
  rows dated after today (`realFuture`, e.g. postdated standing orders).
- Outputs: `monthlyPlanned` (per month income/expenses/net — the current
  month counts from today, so the dashboard stacks real partials + remaining
  plans), `projectedBalance` (running balance at today + every day with
  movement), `plannedCategories` (per category, share of planned expenses),
  `horizon`.

## API

All routes `runtime = "nodejs"`, `dynamic = "force-dynamic"`, hand-rolled
validation (error `{error: "code", message}`), session-scoped, CSRF on
writes ([api.md](api.md)):

| Route                                              | Purpose                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/plans`                                   | list + `nextDueDate` per plan                                                                                                                                                       |
| `POST /api/plans`                                  | create; validates `amountCents ≠ 0`, `dtstart` ISO (not before 1900), RRULE allowlist + ≥ 1 occurrence, ownership of account/category                                               |
| `PATCH /api/plans/[id]`                            | partial update; dtstart/rule changes re-check occurrence productivity                                                                                                               |
| `DELETE /api/plans/[id]`                           | delete (no other data references plans)                                                                                                                                             |
| `GET /api/plans/occurrences?from&to&accountId`     | expanded window + match states; window ≤ 400 days                                                                                                                                   |
| `GET /api/plans/forecast?months&accountId`         | projection envelope                                                                                                                                                                 |
| `GET /api/transactions/calendar?from&to&accountId` | compact bank rows (Gebucht **and** Nicht gebucht — pending rows carry a Buchungsdatum and show dashed/hollow) for the same window; counterparty = payee (Ausgang) / payer (Eingang) |

## Agent access

The chat agent holds read AND write access to plans
([ADR-0036](adr/adr-0036-agent-plan-write-tools.md)) — the first mutable
tool domain (ADR-0033 shipped read-only tools only). Four registry tools
call the same user-scoped service functions as the routes above
(`ctx.uid`, validation reused wholesale): `list_plans` (compact, capped,
newest first, plus the computed `next_due_date` — the query DSL cannot
expand RRULEs), `create_plan`, `update_plan` (single-field patches incl.
pause/finish via `status`) and `delete_plan`. The tool surface is
snake_case in both directions (args and results, matching the
[ADR-0034](adr/adr-0034-agent-read-query-dsl.md) catalog naming); unknown
arg keys are rejected, and `PlanValidationError` codes surface as
`code: message` tool errors the model can self-correct from. Deletes carry
no mechanical confirmation token — the system prompt makes the model
resolve ids via `list_plans`/`query_data` first, confirm in chat before
`delete_plan`, and prefer `status: finished` for mere completion.

## Frontend

German UI. `/planung` composes the ReUI EventCalendar
([ADR-0024](adr/adr-0024-ui-stack-tailwind-shadcn-base-ui.md) Base UI twin),
the plan list and the plan dialog. Click semantics: a **plan chip** opens
its edit dialog; a **bank chip** navigates to `/transactions?tx=<id>` —
the transactions table queries that single row by id (user-scoped,
independent of any filter state) and expands, highlights and scrolls to
it. The dashboard gains the "Geplant einblenden"
planned-vs-actual mode. Details in [frontend.md](frontend.md#planung).

## Tests

`tests/planning-recurrence.test.ts` (validation table, window expansion,
UTC-noon invariants, short-month skipping), `tests/planning-matching.test.ts`
(tolerance/window/counterparty/greedy), `tests/planning-forecast.test.ts`
(hand-computed to-the-cent scenario incl. matched-exclusion and account
scoping), `tests/plans-api.test.ts` (routes: 401/400/404 mapping,
canonicalization, user isolation) — see [testing.md](testing.md).
