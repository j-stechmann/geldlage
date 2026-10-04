# ADR-0026: Server-side SQL filtering/sorting/pagination; hand-rolled table (no react-table)

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

The transactions table can hold thousands of rows; the dashboard needs
filtering (text, dates, type, category), sorting, and pagination. Client-side
table libraries would need the full dataset in the browser.

## Decision

**Everything happens in SQL** ([lib/analytics/queries.ts](../../lib/analytics/queries.ts)):
`buildWhere()` composes the shared filter clause (escaped LIKE, allow-listed
sort keys), `buildOrderBy()` restricts sorting to `amount_cents / payee /
booking_date / value_date / status`, and pagination is `LIMIT/OFFSET` with
`pageSize` clamped to 100. The transactions table component is **hand-rolled on shadcn `Table`
primitives** — the client only serializes filter/page/sort state into the
query string; each state combination is its own React Query cache entry.
Filter changes reset the page via a value-identity pattern (no effects).

`@tanstack/react-table` is _not_ used for this table.

## Alternatives considered

- **@tanstack/react-table (client-side)** — pulls all rows into the browser,
  filters in JS over data SQL already indexed; wrong layer for this data
  volume.
- **URL as the only state store** — partially adopted (filters flow through
  `filtersToParams`), but pagination/sort stay component state for snappier
  UX.

## Consequences

- Positive: constant memory in the browser, exact `pageCount`, sorting uses
  SQL indexes; analytics and table share one filter implementation.
- Negative: a custom table must hand-maintain a11y and sort indicators
  (small surface); server round-trips on every interaction (fast locally).
