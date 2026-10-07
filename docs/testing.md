# Testing

_Last reviewed against v1.14.1 (streaming SSE client tests: frame reassembly, UTF-8 across chunk boundaries, mid-stream timeout classification; agent panel ADR-0033)._

The suite is **entirely in-process** — no Next dev server, no HTTP listener,
no supertest. It runs with `bunx vitest run` (config: [vitest.config.ts](../vitest.config.ts),
node environment by default, `tests/**` only). Test files cover parsing,
money, dedupe, reconciliation, the import pipeline, the labeller, the LLM
client, label/rule services, full analytics correctness, the agent loop,
the agent thread API access matrix, thread titling, and — in a jsdom
environment opted in per file via the `// @vitest-environment jsdom`
docblock (Vitest 4 removed `environmentMatchGlobs`) — the agent panel
components.

```bash
make test          # or: bunx vitest run
```

## Strategy

1. **Route handlers invoked directly.** Handlers are plain functions; tests
   import `GET/POST/PATCH/DELETE` from `app/api/...` and call them with
   synthetic `NextRequest` objects, passing Next 16 async params as
   `{ params: Promise.resolve({ id: "…" }) }`. HTTP semantics (status codes,
   JSON bodies) are asserted without a server.
2. **The LLM is always stubbed.** `vi.stubGlobal("fetch", …)` mimics
   llama-server's `/health` and `/v1/chat/completions` protocol; a helper
   even parses the `[n]` markers in a prompt and echoes one label per index.
   No test talks to a real model.
3. **In-memory SQLite per test.** `createTestDb()` + `setTestDb()` from
   `lib/db` (the `process.env.VITEST` seam in `getDb()`) give each file a
   fresh `:memory:` database with foreign keys on.
4. **Oracle testing to the cent** — the heart of the suite (below).
5. **Races are simulated with SQLite mechanics**, not mocks: a `CREATE
TRIGGER … RAISE(ABORT, 'UNIQUE constraint failed: …')` reproduces the
   exact constraint race, and `PRAGMA foreign_keys = OFF` force-deletes
   simulate concurrent label deletion.

## Fixture + manifest oracle testing

[scripts/generate-fixture.ts](../scripts/generate-fixture.ts) generates a
**deterministic** 24-month synthetic DKB export (a seeded LCG exists but is
deliberately unused) plus a hand-computed KPI manifest — a second, independent
implementation of the analytics. The integration test runs the _real_
pipeline (parser → dedupe → insert) and asserts every KPI against the
manifest **to the cent** ([ADR-0021](adr/adr-0021-oracle-fixture-testing.md)):

- current balance, average monthly income/expenses, savings rate
  (`toBeCloseTo(..., 10)`), per-month cashflow,
- hand-computed balance-timeline back-calculation (with explicit arithmetic
  in the test comments),
- top categories, pending-row exclusion, re-import dedupe,
- date-window semantics: partial-month exclusion from averages, the
  "slice-not-recompute" balance oracle against unfiltered results,
- savings-history edge cases (stale imports, future bookings, running month),
- raw-SQL "oracles" inside tests as an independent check against the same DB.

A **second fixture** (`fixture-pending-resolved.csv`) drives the
reconciliation test: all 24 pending rows re-exported as booked (+2 days,
February clamped to month end (29.02.24 / 28.02.25) — still inside the ±7-day
window), exactly one
with changed content (the upgrade-with-changes path), 10 verbatim booked
copies (exact-dedupe tier), 1 verbatim pending copy, 5 brand-new bookings —
with expected counts recorded in its manifest.

## What each file covers

| Test file                         | Scope                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `money.test.ts`                   | German amount/date parsing, rejection table, **fast-check property round-trips** ([ADR-0020](adr/adr-0020-property-tests-money.md))                                                                         |
| `csv-parser.test.ts`              | BOM/NBSP tolerance, header-name mapping (reordered columns), quoted multi-line purpose, fail-fast errors with row numbers, `peekDkbCsvAccount`                                                              |
| `dedupe.test.ts`                  | Occurrence multiset dedupe: 17 identical same-day rows stay 17, re-import inserts nothing, overlapping exports insert the surplus, hash sensitivity                                                         |
| `match.test.ts`                   | Fuzzy reconcile: ±7-day boundaries, identity chain (IBAN → creditorId → mandateRef), upgrade/skip/refresh, greedy 1:1 pairing, Kundenreferenz self-heal                                                     |
| `pipeline-reconcile.test.ts`      | Reconcile stage against a real DB: upgrade-in-place, skip, refresh, self-heal deletes, the counter invariant, the DKB "format change" scenario                                                              |
| `fixture-integration.test.ts`     | The to-the-cent oracle suite described above                                                                                                                                                                |
| `fixture-reconcile.test.ts`       | Two-stage reconcile against fixture 2; manifest counts; February day-clamping                                                                                                                               |
| `import-worker-handshake.test.ts` | Single-flight flag set/cleared, 409 on concurrent import, all-pending drain, `resetStuckBatches` (labeling excluded), partial-chunk failure safety, retry reset                                             |
| `labeller-worker.test.ts`         | Claim semantics (attempts++, status untouched), `tick()` with stubbed fetch, suggestion injection, partial output marking, batch drain, `SQLITE_BUSY` containment, attempts-snapshot guards                 |
| `labels-service.test.ts`          | `resolveAndUseCategory`, label-deletion reset + rollback atomicity, rule cascade, orphan pruning, `isValidLabelName`                                                                                        |
| `labels-api.test.ts`              | Route handlers for labels/rules: CRUD, 400/404/409 mapping, trigger-simulated unique races, rule learning on assignment                                                                                     |
| `label-rules-edit-apply.test.ts`  | Rule PATCH (trim-to-CSV-values), triple conflict 409, matches preview, apply (reset + re-point batches + refresh totals), concurrent-delete 404                                                             |
| `llm-client.test.ts`              | Index pinning/dropping, slot preservation, prose-poisoned JSON extraction, retry taxonomy (**timeouts never retried**), `temperature: 0` + `json_schema` on the wire, `max_tokens` scaling, context warning |
| `prompt.test.ts`                  | Positional markers, suggestion rendering, marker neutralization (fixed point of odd runs), 512-byte truncation on char boundaries, `responseSchema` bounds                                                  |
| `db-migration.test.ts`            | **Real file DBs** in temp dirs: a DB built with the _previous release's_ `label_rules` DDL is dropped/rebuilt into the triple shape without crashing; fresh DBs get the full schema                         |
| `agent-loop.test.ts`              | Tool loop against a mock SSE llama-server: round budget with tools-strip on the final request, tools-free retry after an empty answer, tool JSON error absorption, windows/sanitization                     |
| `agent-tools.test.ts`             | `get_category_totals`: period boundary math, per-uid isolation (two users querying the same categories), fold correctness, wire-shape derivation from the registry                                          |
| `agent-threads-api.test.ts`       | The full access matrix (owner/member/invited/outsider) per endpoint, 404-not-403 existence nondisclosure, invite idempotency, FK-violation mapping, leave/decline/delete semantics                          |
| `agent-thread-title.test.ts`      | AI titling: sanitize rules, default-title guard (call-time + on write), substring fallback on model failure/empty answer, detached error swallowing                                                         |
| `agent-titling-route.test.ts`     | Chat route integration: title fires once after the first turn only; user-renamed threads never hit the LLM for titling                                                                                      |
| `sse-crlf.test.ts`                | Shared SSE frame parsing regressed on CRLF-reframed bodies, `event:` name extraction, multi-line `data:` joining, final frame without trailing blank line                                                   |
| `agent-panel-state.test.tsx`      | `panel-state` store (jsdom): open/width defaults, `localStorage` persistence, lazy hydrate clamping, `clampWidth` bounds (ResizeHandle contract)                                                            |
| `agent-sse-events.test.tsx`       | Client SSE dispatcher (jsdom): all six event types, routing by event name (payload containing "event: done" not misrouted), malformed-frame skip, CRLF reframe tolerance                                    |
| `agent-panel-ui.test.tsx`         | `AgentChat` (jsdom, stubbed fetch): stored message rendering, the streaming lifecycle (optimistic user bubble + streamed content/tool chips → persisted rows after done), invited join panel, empty state   |

### DOM tests (jsdom)

Component tests opt in per file with `// @vitest-environment jsdom` and use
[tests/helpers-dom.tsx](../tests/helpers-dom.tsx): a React Query wrapper
(`renderWithQuery`), a per-pathname fetch stub with scriptable JSON/SSE
responses (`stubFetch`, `once` entries for differing refetches), a gated
`ReadableStream` for asserting mid-stream UI, an in-memory `localStorage`
polyfill (Node ≥26 exposes a broken global `localStorage` getter stub that
otherwise shadows jsdom's working storage during vitest's global
population), and `matchMedia`/`scrollTo` stubs for jsdom gaps. RTL
`cleanup()` is registered module-side because vitest runs without
`globals: true`.

## Property-based testing — deliberately narrow

Only money parsing uses [fast-check](https://fast-check.dev/)
([ADR-0020](adr/adr-0020-property-tests-money.md)): a 10,000-case round-trip
`cents → formatCentsAsGerman → parseGermanAmountToCents ≡ identity` plus a
second property over explicitly constructed German strings, with one
documented exception (`-0,00` — negative zero is not a meaningful amount).
Everything else is deterministic examples: the fixture is a spec, not a
random sample, so failures are reproducible and assertions are exact.

## Test seams the code provides

- `tests/setup.ts` pins env: `DATABASE_PATH=":memory:"`,
  `LLM_BATCH_SIZE="100"`, `LLM_MAX_RETRIES="0"` (the LLM-client tests
  override retries to 2 locally).
- `lib/db/index.ts` exposes `createTestDb()` / `setTestDb()` /
  `resetDefaultDbForTest()`; `getDb()` branches on `process.env.VITEST`.
- `resetConfigCache()` (lib/config.ts) lets tests change env between cases.
- The globalThis singletons (`__geldlageImportJob`, worker state) are reset in
  `beforeEach` where jobs are involved; `flush()` helpers settle promise
  chains deterministically.

## Correctness posture

The root README's claim — amounts "verified by a test suite that includes
property-based round-trips (20k random amounts), a synthetic 24-month fixture
with a hand-computed KPI manifest asserted to the cent through the real HTTP
API" — maps to `money.test.ts`, `fixture-integration.test.ts`, and the
direct-handler technique described above. CI runs the whole suite plus lint,
typecheck, and build on every push ([operations.md](operations.md)).
