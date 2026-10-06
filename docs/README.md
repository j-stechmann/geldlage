# Geldlage — Documentation

_Docs describe intent; code comments remain the source of truth. Guides carry a "Last reviewed against vX.Y" footer — refresh it when a PR changes what they document._

Documentation for the Geldlage app (Next.js + SQLite + local LLM
labeller): how it is built, why it is built that way, and how to run and
extend it.

## Guides

| Guide                              | Contents                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md) | System overview, process model, startup sequence, core invariants, performance facts                     |
| [data-model.md](data-model.md)     | All tables, connection management, schema creation/migration incl. the destructive `label_rules` rebuild |
| [csv-import.md](csv-import.md)     | DKB CSV format, German money/date parsing, import pipeline, occurrence dedupe, fuzzy reconciliation      |
| [labelling.md](labelling.md)       | Worker loop, claim semantics, LLM client + prompts, label rules, completion/failure/deletion             |
| [analytics.md](analytics.md)       | KPI formulas, full-month trimming, savings history, balance back-calculation, scoping rationale          |
| [frontend.md](frontend.md)         | React Query conventions, pages, polling, chart zoom, UI stack, category colors                           |
| [api.md](api.md)                   | REST reference: all routes, shapes, status codes, conventions (descriptive appendix)                     |
| [operations.md](operations.md)     | Makefile, model management, Docker, CI/release, env vars, security posture, backup, troubleshooting      |
| [testing.md](testing.md)           | Test strategy, fixture + manifest oracle testing, per-file coverage, test seams                          |

## Reading order

**I want to run it** → root [README](../README.md) (setup + compose) →
[operations.md](operations.md) (beyond-README parts: model management,
backup, troubleshooting) → [api.md](api.md) as reference.

**I want to contribute code** → [architecture.md](architecture.md) →
[data-model.md](data-model.md) → [csv-import.md](csv-import.md) →
[labelling.md](labelling.md) → [analytics.md](analytics.md) →
[testing.md](testing.md); skim the ADR index below as you touch each area.

**I maintain this** → [operations.md](operations.md) →
[testing.md](testing.md) → the full ADR index.

Question-routed: "the labeller is stuck" →
[operations.md#troubleshooting](operations.md#troubleshooting) ·
"why doesn't the balance chart match my filter?" →
[analytics.md](analytics.md) · "why was my rule table rebuilt?" →
[ADR-0018](adr/adr-0018-verbatim-triple-rule-keys.md) ·
"how do I add a KPI?" → [analytics.md](analytics.md) +
[testing.md](testing.md).

## Glossary

German is load-bearing: DKB CSV values are stored verbatim, and the UI is
German. These terms appear in code, schema, and docs.

| Term                                            | Meaning                                                                                                       | Where                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Gebucht` / `Nicht gebucht`                     | Booked / pending transaction — only `Gebucht` rows are labeled and counted                                    | `transactions.status`; [csv-import.md](csv-import.md) |
| `Ausgang` / `Eingang`                           | Outflow / inflow (`Umsatztyp`); determines the counterparty direction                                         | `transactions.type`; [data-model.md](data-model.md)   |
| `Buchungsdatum` / `Wertstellung`                | Booking date / value date (CSV columns 1–2)                                                                   | [csv-import.md](csv-import.md)                        |
| `Zahlungspflichtige*r` / `Zahlungsempfänger*in` | Payer / payee (CSV columns) — half of the rule triple                                                         | [csv-import.md](csv-import.md)                        |
| `Verwendungszweck`                              | Purpose / reference text (may be quoted, multi-line)                                                          | [csv-import.md](csv-import.md)                        |
| `Gläubiger-ID` / `Mandatsreferenz`              | Creditor ID / SEPA mandate reference — SEPA identity fields used by the reconcile fallback chain              | [csv-import.md](csv-import.md)                        |
| `Kundenreferenz`                                | Customer reference — DKB's per-contract reference for recurring SEPA debits; the booked↔booked identity field | [ADR-0007](adr/adr-0007-fuzzy-reconciliation.md)      |
| `Kontostand`                                    | Account balance snapshot in the CSV preamble — the balance anchor                                             | [analytics.md](analytics.md)                          |
| `Kategorie` / `Label`                           | Used interchangeably: the `categories` table is the label vocabulary                                          | [labelling.md](labelling.md)                          |
| `ohne Kategorie`                                | "Without category" — the visible state of `failed`/unlabeled rows; never a fallback label                     | [ADR-0013](adr/adr-0013-no-fallback-labels.md)        |
| `erfunden` / `manuell`                          | Label origin: invented by the LLM vs. user-created/assigned                                                   | `categories.origin`; [data-model.md](data-model.md)   |
| `wird kategorisiert`                            | "Being categorized" — the pending state shown in the table                                                    | [frontend.md](frontend.md)                            |
| `Monatssaldo` / `laufender Monat`               | Monthly savings / running month (dashed bar in the savings chart)                                             | [analytics.md](analytics.md)                          |

## ADR index

All decisions live in [docs/adr/](adr/) (MADR-style: Context, Decision,
Alternatives, Consequences). Numbered chronologically; grouped by layer
here. Guides cross-link to the ADRs they implement.

### Toolchain & platform

| ADR                                                   | Decision                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [0001](adr/adr-0001-bun-toolchain.md)                 | Bun + Next.js 16 + React 19 + strict TypeScript toolchain                               |
| [0004](adr/adr-0004-better-sqlite3-wal-singleton.md)  | better-sqlite3 + WAL + synchronous singleton (drizzle as query builder)                 |
| [0005](adr/adr-0005-code-first-ddl.md)                | Code-first idempotent DDL + hot-reload healing (no migration files)                     |
| [0008](adr/adr-0008-in-process-workers-globalthis.md) | In-process background workers via globalThis singletons                                 |
| [0031](adr/adr-0031-no-auth-local-first-privacy.md)   | No-auth, local-first privacy posture                                                    |
| [0032](adr/adr-0032-multi-user-oidc.md)               | Multi-user OIDC authentication with per-user data isolation (supersedes 0031's no-auth) |

### Data & import

| ADR                                               | Decision                                                       |
| ------------------------------------------------- | -------------------------------------------------------------- |
| [0002](adr/adr-0002-integer-cents.md)             | Integer cents for all money                                    |
| [0003](adr/adr-0003-fail-fast-csv-parsing.md)     | Fail-fast CSV parsing with header-name mapping                 |
| [0006](adr/adr-0006-occurrence-aware-dedupe.md)   | Occurrence-aware content-hash dedupe (multiset union)          |
| [0007](adr/adr-0007-fuzzy-reconciliation.md)      | Fuzzy ±7-day reconciliation with deterministic greedy matching |
| [0018](adr/adr-0018-verbatim-triple-rule-keys.md) | Verbatim (payer, payee, counterparty IBAN) triple rule keys    |

### Labeling & LLM

| ADR                                                    | Decision                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [0009](adr/adr-0009-worker-reliability-protocol.md)    | Worker reliability protocol (claim-time attempts, health gate, drain detection)       |
| [0012](adr/adr-0012-local-llama-server.md)             | Local llama.cpp llama-server via OpenAI-compatible API                                |
| [0013](adr/adr-0013-no-fallback-labels.md)             | No fallback labels — explicit `failed` state                                          |
| [0014](adr/adr-0014-claim-time-attempt-increment.md)   | Attempt increment at claim time + attempts-snapshot guards                            |
| [0015](adr/adr-0015-health-gate.md)                    | Health gate before labeling ticks                                                     |
| [0016](adr/adr-0016-grammar-constrained-decoding.md)   | Grammar-constrained decoding, context budget guard, retry taxonomy                    |
| [0017](adr/adr-0017-marker-neutralization-symmetry.md) | Marker-neutralization symmetry between prompt and stored labels                       |
| [0033](adr/adr-0033-agent-panel-tool-loop.md)          | Agent chat panel: native tool loop over the shared llama-server, invite-based threads |

### API & frontend

| ADR                                                      | Decision                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| [0023](adr/adr-0023-client-components-react-query.md)    | Client components everywhere; React Query as the data layer     |
| [0024](adr/adr-0024-ui-stack-tailwind-shadcn-base-ui.md) | Tailwind v4 + shadcn "base-nova" on @base-ui/react              |
| [0025](adr/adr-0025-manual-api-validation.md)            | Manual API validation; zod reserved for environment config      |
| [0026](adr/adr-0026-server-side-table.md)                | Server-side SQL filtering/sorting/pagination; hand-rolled table |

### Analytics

| ADR                                              | Decision                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| [0022](adr/adr-0022-balance-back-calculation.md) | Balance back-calculation from snapshot anchors; time-scoped-only balance/savings |

### Operations & process

| ADR                                          | Decision                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [0010](adr/adr-0010-single-flight-import.md) | Single-flight import job with 202 + client polling                      |
| [0011](adr/adr-0011-startup-recovery.md)     | Startup recovery semantics (stuck-batch reset excludes labeling)        |
| [0019](adr/adr-0019-live-batch-counters.md)  | Batch counters computed live, not trusted from storage                  |
| [0027](adr/adr-0027-docker-posture.md)       | Docker posture — NAPI prebuilds, standalone output, single write target |
| [0028](adr/adr-0028-shallow-healthcheck.md)  | Shallow, liveness-only container healthcheck                            |
| [0029](adr/adr-0029-git-flow-release.md)     | Git-flow with GitHub Release as publish trigger, immutable exact tags   |
| [0030](adr/adr-0030-dependabot-policy.md)    | Dependabot minor/patch-only with redundant major blocking               |

### Testing

| ADR                                            | Decision                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| [0020](adr/adr-0020-property-tests-money.md)   | Property-based tests only for money parsing; oracle fixtures elsewhere |
| [0021](adr/adr-0021-oracle-fixture-testing.md) | Oracle testing via generated fixture + KPI manifest                    |

## Maintaining these docs

- A PR that changes behavior must update the guide/ADR it crosses — in the
  same PR ([CONTRIBUTING.md](../CONTRIBUTING.md), "Documentation").
- Refresh the `Last reviewed against vX.Y` footer of every guide you touch;
  the release checklist reminds you.
- CI link-checks `docs/**` on every push (see `ci.yml`).
