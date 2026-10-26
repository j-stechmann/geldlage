# ADR-0035: Geplante Transaktionen — virtual overlay, read-time matching, full RRULE

_Status: accepted · Date: 2026-10_

## Context

Geldlage analyzes what the bank _already booked_ (CSV import). Users also
plan what money _will_ move — recurring rent, salary, subscriptions,
insurance, one-off vacations. Future transactions need a home that never
corrupts the core invariant "the `transactions` table is what the bank said"
(dedupe occurrence multiset [ADR-0006](adr-0006-occurrence-aware-dedupe.md),
learned rules [ADR-0018](adr-0018-verbatim-triple-rule-keys.md), snapshot
anchors [ADR-0022](adr-0022-balance-back-calculation.md) all assume bank
truth).

## Decision

1. **Planned transactions are virtual.** A new `planned_transactions`
   table (`user_id`, nullable `account_id` = "any account", free-text
   `counterparty`/`purpose`, signed `amount_cents` (ADR-0002), optional
   `category_id`, `dtstart`, nullable `rrule` (NULL = one-off on `dtstart`),
   `status` `active|paused|finished`, `notes`). Occurrences **never enter
   `transactions`** — plans render beside real data (calendar on `/planung`,
   dashboard overlay), the labeller/dedupe/balance machinery stays untouched.

2. **Full RRULE, allowlisted.** The rule lives as a bare RFC 5545 RRULE
   value; `lib/planning/recurrence.ts` parses with the `rrule` package and
   enforces an allowlist before storing: `FREQ ∈ {DAILY, WEEKLY, MONTHLY,
YEARLY}`, parts limited to `INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/
BYMONTH/BYSETPOS/WKST`, `INTERVAL ≤ 100`, `COUNT ≤ 366`, reject
   `SECONDLY/MINUTELY/HOURLY/BYHOUR/BYMINUTE/BYSECOND/BYWEEKNO/BYYEARDAY/
EXDATE/RDATE` as well as multi-line/`DTSTART:` pastes (dtstart is a
   column — a pasted DTSTART must not teleport the plan). Canonical storage
   is rrule's own serialization. Expansion anchors every date at **noon
   UTC** (`Date.UTC(y, m-1, d, 12)`): UTC has no DST and month ends round
   identically; ISO dates are read from UTC parts — and the rule is always
   rebuilt with the column's dtstart, because `rrulestr`-only rules default
   `dtstart` to _now_ and silently empty pre-today windows.
   **RRULE semantics are RRULE's**: monthly `BYMONTHDAY=31` SKIPS short
   months (bank debits would clamp to month end); the form warns when day
   ≥ 29 is picked. `COUNT ≤ 366` + window caps bound every expansion.

3. **Read-time matching, zero storage.** Each occurrences request pairs
   planned occurrences with real `Gebucht` rows of the same user (± the
   plan's account): deterministic greedy 1:1 (mirroring
   [ADR-0007](adr-0007-fuzzy-reconciliation.md)) — same sign, booking date
   in `[due − 5 d, due + 7 d]`, amount within `max(5 €, 1 %)`, and — when
   the plan carries a counterparty — a normalized case-insensitive
   substring match against payer/payee. Nothing persisted: changing or
   deleting a plan leaves no stale match rows ever (ADR-0019 spirit).
   Occurrence states therefore derive: **erwartet / überfällig (unmatched,
   past due) / gebucht (matched, ✓)**.

4. **The forecast is a third analytics scope in its own endpoint**
   (`GET /api/plans/forecast`). `computeAnalytics` and its
   two-scope/`buildTimeScopedWhere` invariant stay untouched. The forecast
   starts at the snapshot-anchored current balance (same anchor math as
   engine.ts) and projects forward with **unmatched** planned occurrences
   plus already-booked future dates — matched plans and booked money never
   double-count. Real amounts never enter projected sums; planned amounts
   never enter real analytics. Monthly planned sums for the current month
   count from TODAY (the dashboard merges partial actuals with the
   remaining plans).

5. **Calendar UI from the ReUI shadcn registry** (`@reui/event-calendar`,
   Base UI twin matching the app's `@base-ui/react` primitives, base-nova
   style). Copy-and-own source under `components/reui/` (ADR-0026
   philosophy). The calendar is a VIEW layer: it consumes server-expanded
   occurrences as plain events; the server (`rrule`) is the single
   expansion truth. Drags/resize stay off by design: editing an occurrence
   means editing its plan (a drag would ambiguously rewrite DTSTART/RRULE).
   `rrule` also powers the client preview in the plan dialog — same engine
   on both sides, so preview == calendar == forecast.

## Alternatives considered

- **Materialize on due date** — insert synthetic rows into `transactions`:
  rejected outright; it would pollute dedupe, learned rules, balances and
  the LLM prompt with non-bank data.
- **Materialized match table** — persisted plan↔transaction pairs:
  rejected; plan edits would orphan rows and the live computation is cheap
  at personal-finance volumes.
- **Typed recurrence presets instead of RRULE** (monthly/weekly/…): the
  UI could stay simpler, but "every 2nd Friday", `BYMONTHDAY=-1` and yearly
  patterns are real bank rhythms and the user asked for full RRULE; the
  builder hides the wire format, raw editing stays possible.
- **react-big-calendar / FullCalendar**: heavier and Radix-/native-CSS
  flavored; ReUI's Base UI twin fits ADR-0024's stack with the least
  adaptation.

## Consequences

- Positive: future money becomes visible and plannable (calendar, overdue
  check-offs, balance projection) without touching a single line of the
  correctness core; plans are per user like everything else; the agent can
  answer "was ist diesem Monat noch geplant?" via the query DSL catalog.
- Negative: two date engines coexist (analytics' string-sliced months vs.
  planning's noon-UTC rrule) — both UTC-anchored, tested against the same
  fixtures; RRULE's skip-short-months semantics must be explained in the
  form; tolerance-based matching is heuristic by nature (5 € / 1 % window,
  documented and constant-driven).
