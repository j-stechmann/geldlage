# Planning (geplante Transaktionen)

Future money, planned by hand: the `/plans` page manages **virtual plans**
— recurring (full RFC 5545 RRULE) or one-off — and `/calendar` renders their
occurrences next to real bookings, checks them off, and projects the balance
on the dashboard. Implemented per
[ADR-0035](adr/adr-0035-planned-transactions-rrule.md); the design invariant
is _not touching a single line of the analytics/import/labelling core_:
plans are virtual, matching is read-time, the forecast is its own endpoint.

## Data model

One new table `planned_transactions`
([lib/db/schema.ts](../lib/db/schema.ts), DDL in
[lib/db/index.ts](../lib/db/index.ts)):

| Column         | Type       | Notes                                                                                                                                                        |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | TEXT PK    | UUID                                                                                                                                                         |
| `user_id`      | INTEGER FK | owning user — plans are per user like every domain table                                                                                                     |
| `account_id`   | INTEGER FK | nullable: NULL = plan applies to "any account" (visible under the account filter tool)                                                                       |
| `counterparty` | TEXT       | free text; drives the match ("Mietwerk GmbH")                                                                                                                |
| `purpose`      | TEXT       | free text                                                                                                                                                    |
| `amount_cents` | INTEGER    | signed cents ([ADR-0002](adr/adr-0002-integer-cents.md)); CHECK `<> 0`                                                                                       |
| `category_id`  | INTEGER FK | nullable                                                                                                                                                     |
| `dtstart`      | TEXT       | first occurrence, ISO `YYYY-MM-DD`                                                                                                                           |
| `rrule`        | TEXT       | bare RFC 5545 RRULE value, allowlisted (below); **NULL = one-off on `dtstart`**                                                                              |
| `status`       | TEXT       | `active / paused / finished` (CHECK enforced; paused stays visible on the calendar and plan list but is excluded from the forecast, finished doesn't expand) |
| `notes`        | TEXT       |                                                                                                                                                              |

Indexes: `planned_transactions_user_status_idx` `(user_id, status)` and
`planned_transactions_account_idx` `(account_id)`.

## Recurrence (`lib/planning/recurrence.ts`)

- **Validation before storage** ([ADR-0035](adr/adr-0035-planned-transactions-rrule.md)):
  `FREQ ∈ {DAILY, WEEKLY, MONTHLY, YEARLY}`; parts allowlist
  `INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/BYMONTH/BYSETPOS/WKST`;
  `INTERVAL 1–100`, `COUNT 1–366`; multi-line texts and `DTSTART:`/`EXDATE:`/
  `RDATE:`-carrying inputs rejected. `TZID=` parts are rejected outright,
  not silently stripped — rrule's string parser never carries the part into
  `origOptions`, so only a textual guard can keep canonicalization from
  pretending the user never wrote it. Ordinal (numeric) `BYDAY` values
  (`1FR`, `-1SU`) are rejected for DAILY/WEEKLY — RFC-invalid, and rrule
  silently _ignores_ the ordinal there. Canonical stored form is rrule's
  serialization (no `RRULE:` prefix; `+1FR` ordinals normalized to `1FR`).
  `UNTIL` inputs are lifted to **noon UTC** (any sub-noon datetime form —
  date-only, midnight, `06:00Z` …, floating no-Z included; times at/after
  noon stay) so the final noon-anchored occurrence on the named day stays
  included — applied at read time as well, so pre-fix stored rules expand
  consistently.
- **Expansion**: `expandOccurrenceDates(dtstart, rrule, {from, to}, cap)`.
  Every rule is rebuilt with an **explicit dtstart** — `rrulestr` alone
  defaults `dtstart` to _now_ and would silently empty pre-today windows.
  Dates anchor at **noon UTC** (`Date.UTC(y, m-1, d, 12)`) so DST never
  shifts a day and month ends behave; ISO strings are read from UTC parts.
- **Short months clamp to month end**: a positive monthly/yearly
  `BYMONTHDAY` anchor that a month cannot hold (29–31) fires on that
  month's **last day** instead of skipping the month — `BYMONTHDAY=31` gives
  Feb 28/29, Apr 30, …; a yearly `BYMONTH=2;BYMONTHDAY=29` fires every year
  (Feb 28 in non-leap years); yearless `YEARLY;BYMONTHDAY=31` fires on all
  12 month ends. Anchors that clamp to the same month end collapse to one
  occurrence, `COUNT` counts the clamped dates and `UNTIL` includes a
  clamped month end on or before its day. Only plain day-of-month rules
  clamp: `BYDAY` / `BYSETPOS` intersections keep RRULE semantics, as do raw
  DAILY/WEEKLY `BYMONTHDAY` filters and rules whose day comes from `DTSTART`
  (no `BYMONTHDAY` part). Legacy/corrupt rows with parts `validateRrule`
  rejects (e.g. an out-of-range `BYMONTH`, `BYYEARDAY`, `BYEASTER`) also keep
  RRULE semantics instead of being resurrected by the clamp. The create/edit
  form explains the rule when day ≥ 29 is chosen (monthly always, yearly
  when no month is selected or a selected month can be short). Expansion
  happens at read time, so this also applies to already-stored plans: a
  stored `BYMONTHDAY=31` rule now fires in short months, and a `COUNT`-bounded
  plan can end sooner.
- `nextOccurrenceDate` powers the list's "Nächster Termin"; both are
  bounded: window expansion caps at 2000 occurrences, the next-date scan
  walks a five-rung horizon ladder (400 → 147 000 days — the closing rung
  spans one Gregorian 400-year cycle) so unbounded rules can never scan
  forever while sparse live rules still report their real next date: a live
  plain clamped `BYMONTHDAY` rule fires within a century (a `BYMONTH` filter
  can add at most 12 `MONTHLY` interval steps, and a `YEARLY` interval is
  itself ≤100 years), and a century-cadence
  weekday intersection can span up to one 400-year cycle. A large
  `INTERVAL` combined with a calendar-dependent
  `BYDAY`/`BYSETPOS` filter (e.g.
  `YEARLY;INTERVAL=97;BYMONTH=2;BYMONTHDAY=29;BYDAY=TU`) can space matches
  thousands of years apart, as can raw DAILY/WEEKLY `BY*` filters; past the
  ladder they honestly read as no next date. Rung window ends
  clamp at `9999-12-31` (the last storable ISO date) — an unclamped end
  would cross into toISOString's extended-year form, truncate into an
  Invalid Date and make every rung answer "no occurrences"; occurrences
  beyond that bound are unrepresentable as ISO dates and honestly read as
  none. **Cost note (deliberate for now):** rrule has no seek — every read
  of a rule expanded through rrule re-walks occurrence-by-occurrence from
  `dtstart` until the read window is behind it, so the per-plan cost driver
  is **dtstart age** (walk distance), and it grows forever: measured on this
  repo's engine, a DAILY plan costs ~4 ms per read window when young, ~14 ms
  at a 2006 dtstart and ~68 ms at the 1900 floor — ~0.5 ms per year of plan
  age, linear in plan count per read (`GET /api/plans` + agent `list_plans`
  next-dates, calendar occurrences, forecast) — so the planning reads scale
  with the OLDEST live plan rather than with plan count. The arithmetic
  clamp path starts at the read window unless `COUNT` forces counting from
  `dtstart`. The paged `/plans` table limits the walk
  to the rows on screen (the count query computes no `nextDueDate`), and the
  calendar/matched-plan lookups pass `includeNextDue=0`. If that grows:
  persist `next_due_date` at write time and refresh drifted rows in a bounded
  worker-tick trickle, instead of expanding per read.

## Occurrence matching (`lib/planning/matching.ts`)

Read-time, deterministic greedy 1:1 (same pairing style as the import
reconcile, [ADR-0007](adr/adr-0007-fuzzy-reconciliation.md)):

| Rule         | Value                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidates   | booked (`Gebucht`) rows of the user, in `[window.from − 5 d, window.to + 7 d]`, padded by the tolerances below — deliberately NOT `Nicht gebucht` rows: a plan check-off means the money is IN the account |
| Sign         | transaction must carry the **same sign** as the plan; zero-cent rows never match (reservation placeholders — as non-positives they would slip the sign check and pass via the 5 € tolerance floor)         |
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
  Same-snapshotDate batches (two accounts imported on one day) tie-break
  deterministically — freshest import first (`createdAt`, then `id`,
  `isLaterAnchor`), the identical rule the balance KPI applies; both scopes
  also ignore snapshots dated **after** today (a future-dated Saldo line
  never anchors one scope while the other rejects it), so the KPI and the
  forecast can never pick different snapshots for the same user.
  Inherited anchor caveat (same as the analytics balance KPI): the anchor
  is the single latest snapshot _batch_ — an all-accounts projection of a
  user whose accounts carry **per-account snapshots** enters only that one
  account's snapshot money (Σ booked stays all-account), so the starting
  balance can be understated; account-scoped forecasts are exact.
- **Planned aggregates use occurrences of ACTIVE plans that are not booked
  within the projection** from today through `months` (clamped 1–60, default
  12): matched ones are booked money already inside the actuals — including
  them would double-count (the one exception is a match whose booking posts
  after `horizonEnd`, below). A paused plan stays visible on the calendar and
  plan list, but its occurrences never enter the projection. The status
  filter runs _before_ read-time matching, so a paused occurrence cannot
  consume a booked row an active plan still needs (which would leave the
  active occurrence unmatched and count it on top of the real booking).
  This deliberately prioritizes active plans: when matching is ambiguous, a
  nearby compatible active occurrence may claim a booking that "belonged" to
  a paused plan, which excludes the active occurrence from the planned sums
  (the booking then represents the money once) rather than double-counting
  it. The calendar matches paused and active occurrences together, so the
  two views can disagree on which occurrence owns a booking: the calendar
  may show it on the paused occurrence while the forecast treats it as the
  active plan's booking.
  For active plans one horizon edge stays counted: a match whose booking
  posts after `horizonEnd` (within the ± posting-drift window) is outside the
  projection's real data entirely, so the planned occurrence remains its
  only in-horizon representation (`bookingDate ≤ horizonEnd` defines
  "already booked" here); paused occurrences are removed before matching, so
  this edge does not resurrect them. Also included in the _balance
  projection_ (but not the planned sums): booked rows dated after today
  (`realFuture`, e.g. postdated standing orders).
- **Account-agnostic plans (`account_id` NULL) count FULLY toward every
  account-scoped projection** — the same "any account" convention the
  calendar and plan list apply. An account-scoped read narrows only the
  matching: such a plan's occurrences then pair against that account's
  bookings alone.
- Outputs: `monthlyPlanned` (per month income/expenses/net — the current
  month counts from today, so the dashboard stacks real partials + remaining
  plans), `projectedBalance` (running balance at today + every day with
  movement), `plannedCategories` (per category, share of planned expenses),
  `horizon`.

## API

All routes `runtime = "nodejs"`, `dynamic = "force-dynamic"`, hand-rolled
validation (error `{error: "code", message}`), session-scoped, CSRF on
writes ([api.md](api.md)):

| Route                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/plans`                                   | list + `nextDueDate` per plan; `q`/`status` filter (case-insensitive incl. non-ASCII, metacharacters literal), `page`/`pageSize` (≤ 100) page the table — without paging params the full list is returned for existing consumers, and `includeNextDue=0` skips the per-plan next-date walk for lookups that never read it                                                                                                                        |
| `POST /api/plans`                                  | create; validates `amountCents ≠ 0`, `dtstart` ISO (not before 1900), RRULE allowlist + first occurrence within the bounded next-date ladder (five rungs, closing rung ≥ one Gregorian 400-year cycle — sparse-but-live rules whose next date falls inside it, e.g. a century-cadence `BYDAY`+`BYMONTHDAY` intersection, pass; rung ends clamp at the last storable ISO date `9999-12-31`), ownership of account/category                        |
| `PATCH /api/plans/[id]`                            | partial update; dtstart/rule changes re-check occurrence productivity                                                                                                                                                                                                                                                                                                                                                                            |
| `DELETE /api/plans/[id]`                           | delete (no other data references plans)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/plans/occurrences?from&to&accountId`     | expanded window + match states; window ≤ 400 days apart _and_ within ±60 months of today (rules expanded through rrule walk from dtstart occurrence-by-occurrence — no seek — so far windows cost CPU linear in that distance; the arithmetic clamp path starts at the window unless `COUNT` applies)                                                                                                                                            |
| `GET /api/plans/forecast?months&accountId`         | projection envelope                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/transactions/calendar?from&to&accountId` | compact bank rows (Gebucht **and** Nicht gebucht — pending rows carry a Buchungsdatum and show dashed/hollow) for the same window; counterparty = payee (Ausgang) / payer (Eingang); same far-window contract as /occurrences (window ≤ 400 days apart _and_ within ±60 months of today, so the two /calendar window reads fail together — at that distance the calendar answers with a navigation hint instead of the retry that can't succeed) |

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
arg keys are rejected at the tool layer and unknown body keys at the
service layer (`unknown_field` — shared by the REST routes), and
`PlanValidationError` codes surface as
`code: message` tool errors the model can self-correct from. Deletes carry
no mechanical confirmation token — the system prompt makes the model
resolve ids via `list_plans`/`query_data` first, confirm in chat before
`delete_plan`, and prefer `status: finished` for mere completion.

## Frontend

German UI. The views split into `/plans` (the server-paged plan table with
search, status filter, row actions and the plan dialog) and `/calendar`
(the ReUI EventCalendar, [ADR-0024](adr/adr-0024-ui-stack-tailwind-shadcn-base-ui.md)
Base UI twin, plus the plan dialog for chip clicks); `/planung` redirects to
`/plans`. The dashboard's "Geplant einblenden" mode gained the forecast
summary card. Click semantics: a **plan chip** opens
its edit dialog; a **bank chip** opens an action dialog with the
transactions deep link (`/transactions?tx=<id>` — the transactions table
queries that single row by id, user-scoped and independent of any filter
state, then expands, highlights and scrolls to it) and the
**convert-to-plan** entry. Converting opens the plan dialog pre-filled
from the booked transaction (`PlanPrefill` — counterparty, purpose,
amount, booking date, account/category) with a monthly
`BYMONTHDAY=<day-of-month>` recurrence guess; the transaction itself is
never modified and **no linkage is stored** — future occurrences pair up
read-time via matching. The same conversion entry sits in the expanded
detail row of the transactions table's booked rows (`Nicht gebucht`
rows/chips carry no convert entry — the matching engine pairs only
`Gebucht` rows, so a plan built from a pending booking would sit
unmatched until the booked version posts). A booking the matching engine
already claims is offered **plan edit** instead (`useMatchedPlanForTx`
reverse-lookup over the ± posting-drift window; a failed occurrences
read — `window_too_far` or a transient error — resolves as unmatched,
keeping convert available, while a failed plans read on a _found_ match
leaves the affordance disarmed until a refetch resolves the plan list —
the same hold covers the stale-cache window, where the app's 5s-stale
plans snapshot renders while its invalidated refetch is in flight, and
the occurrence lookup holds on its in-flight read the same way: an
invalidated `["plan-occurrences"]` entry serves its pre-plan snapshot
(no match) while the invalidated refetch runs, and reading "unmatched"
from it would re-arm convert against the just-created plan) —
converting would only duplicate the plan. Read-time matches are
window-scoped: with near-duplicate plans, the reverse lookup and the
calendar chip may disagree — a property of the design, not a bug. The
dashboard's "Geplant einblenden" mode overlays the planned bars/line and
shows the forecast summary card. Details in
[frontend.md](frontend.md#plans--planung).

## Tests

`tests/planning-recurrence.test.ts` (validation table, window expansion,
UTC-noon invariants, monthly/yearly month-end clamping incl. COUNT/UNTIL and
leap years), `tests/planning-matching.test.ts`
(tolerance/window/counterparty/greedy), `tests/planning-forecast.test.ts`
(hand-computed to-the-cent scenario incl. matched-occurrence exclusion,
paused-plan exclusion, the paused-vs-active match priority and account
scoping),
`tests/plans-api.test.ts` (routes: 401/400/404 mapping, canonicalization,
user isolation) — see [testing.md](testing.md).
