# ADR-0034: Read-only JSON query DSL for the agent (`query_data`)

_Status: Accepted · Date: 2026-10-19_

## Context

[ADR-0033] gave the agent panel exactly one tool, `get_category_totals` — a
hand-written preset that answers one question shape (per-category sums for a
bounded period). Every new question shape ("what did I send to X this year?",
"spending per month", "which imports failed?") would mean another bespoke
tool, each one a new registry entry and prompt line, and the model stays
unable to combine information across tables.

The natural alternative — letting the model write SQL — is out of the
question for a multi-user finance app ([ADR-0032]): raw SQL in a tool result
is both an injection surface against the model's own output and, worse, a
write path. The data layer is better-sqlite3 + drizzle ([ADR-0004]) with a
single shared connection singleton.

Two small-model realities constrain the design: the model runs locally
(Qwen3 via llama-server, [ADR-0012]), so the query format must be reliably
producible JSON (not a deep expression language), and the context is small
(LLM_CTX default 8192), so the schema reference in the system prompt has a
tight budget.

## Decision

**One new tool, `query_data`, accepting a flat JSON query; a whitelist
catalog + compiler turns it into one SELECT on a dedicated read-only SQLite
connection.** The model expresses intent; the catalog decides what exists.

The DSL has no escape hatches by construction:

```json
{
  "table": "transactions",
  "select": ["booking_date", "payee", "amount_cents", "category.name"],
  "where": [{ "column": "booking_date", "op": "gte", "value": "2026-01-01" }],
  "whereAny": [{ "column": "status", "op": "eq", "value": "Gebucht" }],
  "aggregate": [
    { "fn": "sum", "column": "amount_cents", "alias": "summe_cents" }
  ],
  "groupBy": ["booking_month"],
  "having": [{ "column": "summe_cents", "op": "lt", "value": -50000 }],
  "orderBy": [{ "column": "summe_cents", "direction": "asc" }],
  "limit": 20
}
```

ops: `eq ne gt gte lt lte contains like in isNull notNull`. `contains` is a
literal substring match (the compiler escapes `% _ \` so model wildcards
cannot leak through); `like` takes model-supplied wildcards; both are
text-column ops and ASCII-case-insensitive (SQLite `LIKE` semantics —
`"aldi"` matches "Aldi"; umlauts stay case-sensitive). Integer columns
compare with `eq/gt/lt/in` (a LIKE against
an integer would coerce to text and match nothing). `where` is an
AND list, `whereAny` an OR group AND-ed with `where`. Aggregates
(`sum count avg min max`) with `groupBy` produce grouped rows; without
`groupBy` a single grand-total row. `having` filters aggregate aliases only.
Joins reference whitelisted FK edges by singular alias (`category.name`),
with the join inferred from any dotted reference. Row queries carry an
implicit `rowid` tie-break, so a limited result is stable across calls
(insertion order without `orderBy`, stable ordering of equal keys with one).

### Enforcement — mechanism, layered

1. **No write vocabulary in the DSL.** The JSON Schema sent to
   llama-server has no field that could carry SQL text or a write verb;
   unknown top-level fields are rejected by the parser (fail closed).
2. **Catalog whitelist** (lib/agent/query/catalog.ts) is the single source
   of truth for tables, columns, join edges, and value kinds. Exposed:
   accounts, transactions, categories, label_rules, import_batches —
   deliberately NOT `users` and NOT the chat_* tables. Every column ref
   resolves through it; everything else throws a short, model-readable
   error that reaches the model as `{"error": …}` for self-correction.
3. **Compiled user scoping.** `user_id` is not an addressable column. The
   base table's `user_id = ctx.uid` is forced into every WHERE, and every
   joined table's `user_id = ctx.uid` is forced into its ON clause — ON,
   not WHERE: an unmatched join must keep the row with NULL join columns
   (uncategorized transactions), and a cross-user FK reference yields NULL
   instead of leaking the other user's row.
4. **Read-only connection** (lib/agent/query/readonly-db.ts): the tool
   reads through a SECOND better-sqlite3 handle opened
   `readonly: true` + `PRAGMA query_only` (WAL permits the concurrent
   reader). Even a future compiler bug cannot write — the connection
   itself refuses. Under vitest the test-db seam replaces it.
5. **No string-to-SQL path.** Identifiers render exclusively from catalog
   constants (drizzle `sql` templates); model values interpolate as bound
   parameters only. Value types are checked against the catalog kind
   (integer columns demand integers, text demands strings) so model
   mistakes produce readable errors instead of SQL failures. Aggregate
   functions are kind-checked the same way: sum/avg demand integer columns
   (min/max stay valid on text), and only count may omit its column.
   `having` accepts numeric aliases only — min/max on a text column yield
   a text alias that is orderable (lexicographic) but not filterable,
   because SQLite compares any text greater than any number.
6. **Budgets.** `limit` is clamped to `QUERY_MAX_ROWS` (100; default 20);
   long string cells are capped at `QUERY_MAX_CELL_CHARS` so one `purpose`
   blob cannot eat the tool-result budget; the result then passes through
   the standard `truncateToolResult` cap. When rows were cut, the result
   reports `limited: true` plus `totalMatching` (exact count for row
   queries) so the model can narrow instead of guessing.

### Structured size caps

Conditions ≤ 20, `in` values ≤ 100, select ≤ 64, groupBy/orderBy ≤ 5,
aggregates ≤ 8 — pathological queries are refused, not merely slow.

### Prompt reference generated from the catalog

The table/column/join block in the system prompt is generated from
`queryTables` (lib/agent/query/prompt-doc.ts), so the prompt can never
describe a table or op the interpreter rejects. It is appended only when
`query_data` is actually advertised. Cost: ~580 tokens on the default
catalog; trimming long-tail columns from the catalog shrinks it.

### Derived columns

`booking_month` (`substr(booking_date, 1, 7)`) and `booking_year` — safe
because `booking_date` is TEXT `YYYY-MM-DD` ([ADR-0033] period math relies
on the same lexicographic property). They make "per month/year" answerable
without any expression language in the DSL.

### Consequences

- `get_category_totals` stays: it is optimized (select-and-fold, integer
  cents [ADR-0002]) and its `this_month` defaults match the analytics
  views. `query_data` complements it rather than replacing it.
- Structural rejections at parse time: `groupBy` without any `aggregate`
  (bare-column grouping is undefined in SQLite and a limit cut could not
  report a meaningful group count), duplicate select **and groupBy**
  output keys (refs like `account_id` next to `account.id` compile to
  the same label — a repeated label would silently swallow one of the
  two values in the row object), aggregate aliases colliding with a
  groupBy output key, and — in aggregate mode — `orderBy` refs outside
  `groupBy` (SQLite would silently order groups by an arbitrary row
  value). Aggregate queries report the groupBy keys + aliases, ignoring
  `select` (parse-time validation requires select ⊆ groupBy when
  present).
  All structural mismatches (select ⊆ groupBy, orderBy refs in aggregate
  mode, having on aliases) are rejected at parse time; remaining
  SQLite-level errors surface as `{"error": …}` — self-correctable within
  the AGENT_MAX_TURNS budget.
- `totalMatching` is unreported for grouped queries that hit the limit —
  "how many groups match" would need a subquery for a number the model
  rarely needs; `limited: true` still signals the cut.
- The read-only handle assumes the main write singleton booted first
  (hot-WAL recovery) — true in every runtime path; the vitest seam
  sidesteps it for tests.

## References

- lib/agent/query/catalog.ts, parse.ts, compile.ts, readonly-db.ts,
  prompt-doc.ts; lib/agent/tools/query-data.ts
- tests/agent-query.test.ts — catalog integrity, uid isolation (incl. the
  cross-user-FK join case), aggregates/joins/having/derived columns,
  wildcard escaping, limit clamping, readonly write refusal
- [ADR-0033] tool loop and registry · [ADR-0032] per-user data
- [ADR-0004] WAL singleton read-side semantics · [ADR-0002] integer cents
