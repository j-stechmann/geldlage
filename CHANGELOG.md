# Changelog

## v1.21.0

### Added

- **planning — geplante Transaktionen (calendar, matching, forecast)**:
  future money becomes plannable — recurring (full RFC 5545 RRULE via the
  `rrule` package) or one-off plans live in a new virtual
  `planned_transactions` table and **never touch `transactions`**
  (dedupe/labeling/snapshot machinery unchanged, ADR-0035). New
  `lib/planning/` (recurrence validation allowlist + noon-UTC expansion,
  read-time greedy occurrence matching vs. booked rows with
  erwartet/überfällig/gebucht states — no stored matches, forecast on a
  third analytics scope in `GET /api/plans/forecast`), new routes
  `/api/plans` (+`/[id]`, `/occurrences`, `/forecast`), a `/planung` page
  with the ReUI EventCalendar (Base UI twin, copy-and-own under
  `components/reui/`), a full RRULE builder dialog with live next-dates
  preview (same engine as the server), and a forecast summary card. The
  calendar also renders REAL bank transactions carrying a Buchungsdatum —
  booked (washed `•`) and pending `Nicht gebucht` (dashed hollow `◌`; fed
  by a new `GET /api/transactions/calendar` window endpoint) —, month view
  is the default, all dialog dropdowns display their chosen label (Base UI
  `items` maps), and `UNTIL` forms are normalized (rrule only parses compact
  datetimes; dashed forms compacted, and every sub-noon UNTIL — date-only,
  midnight, `06:00Z` …, floating no-Z included — lifted to noon so the
  final day stays included; also at read time, lifting pre-fix stored
  rules), and validated rules must yield an occurrence within the bounded
  next-date ladder (five rungs, closing rung ≥ the Gregorian 400-year
  cycle — sparse-but-live rules like leap-day yearly are
  creatable, dead rules rejected). Bank chips deep-link to the transactions table
  (`?tx=<id>`; `GET /api/transactions` gained an `id` param —
  `queryTransactionById`, a user-scoped single-row lookup bypassing filters
  and pagination that also shares the row projection with the list query —
  the table queries exactly that row, then expands, highlights and scrolls
  to it; render-time focus adjustment, jsdom-tested). The dashboard's "Geplant einblenden"
  planned-vs-actual mode (dashed
  projection line, stacked planned cashflow/category bars, projected
  horizon balance). The agent's read-only query DSL catalog (ADR-0034)
  gained `planned_transactions`. Tests: RRULE validation/expansion,
  matching tolerances + greedy determinism, forecast oracle to the cent,
  plan API routes; vendored ReUI sources are lint-ignored
  (eslint.config.mjs). Docs: new planning.md + ADR-0035, data-model/api/
  frontend/analytics/testing updated.
- **agent — the LLM can now manage plans (CRUD)**: four new tools
  (`list_plans`, `create_plan`, `update_plan`, `delete_plan`) call the
  same user-scoped planning service as the REST routes (ADR-0036 — first
  write tools; ADR-0033's read-only stance lifted domain by domain).
  `list_plans` returns compact, capped summaries with the computed
  `next_due_date` (the query DSL cannot expand RRULEs); `update_plan`
  patches single fields incl. pause/finish via `status`. snake_case tool
  surface both ways (ADR-0034 naming), loud unknown-field rejection,
  `PlanValidationError` codes folded into `code: message` tool errors the
  model self-corrects from; deletes stay prompt-guarded (resolve ids via
  `list_plans`/`query_data` first, confirm in chat, prefer
  `status: finished`; system prompt gains a registry-gated plan rules
  block). Tests: agent-plan-tools (validation passthrough, cross-user
  isolation, patch semantics, capped summaries, registry/prompt wiring).
  Docs: ADR-0036, planning.md agent-access section, ADR index.

### Fixed

- **planning review follow-ups**:
  `planned_transactions` is now in `adoptLegacyIssuer`'s child tables — the
  legacy-rebrand merge (legacy user + JIT-created duplicate) previously
  died on `DELETE FROM users` with a FK violation (and aborted boot)
  whenever the duplicate workspace held a plan (regression-tested);
  `GET /api/plans/occurrences` bounds the window to ±60 months of today
  (`window_too_far`, 1826 d = the forecast horizon cap) — rrule expansion
  walks from `dtstart` occurrence-by-occurrence (no seek), so far-future
  windows could block the event loop ~0.6 s per DAILY plan
  (window-cap arithmetic also no longer relies on overflowing 4-digit ISO
  `isoDatePlus` near year 9999; regression-tested); unplanned-looking bank
  chips (no counterparty/purpose) on the /planung calendar no longer fall
  back to the word "Geplant" — they read "Buchung"; the /planung page
  surfaces failed plan/calendar/forecast reads with the dashboard's
  ErrorState + retry instead of rendering as silent empty states; the
  Top-Ausgabenkategorien tooltip no longer presents the Ist-period share
  behind a planned-only amount (the planned segment entry prints its
  supplement alone); the plan list's Wiederholung badge states the engine's
  real cadence for yearless YEARLY rules (BYMONTHDAY ⇒ "jedes Monats",
  plain BYDAY ⇒ "jeden <Tag>" — both used to read as a lying "jährlich";
  INTERVAL > 1 is part of the text, BYDAY+BYMONTHDAY intersections fall
  back to the raw rule); an "Alle" (INTERVAL) beyond 100 in the plan dialog
  disarms the dialog with an inline error instead of a green preview
  followed by a save-time 400; the next-date ladder gained a closing rung
  (147,000 d ≥ one Gregorian 400-year cycle) — live rules whose gaps can
  exceed the early rungs (e.g. `YEARLY;INTERVAL=100`) previously read as
  "no future dates" after their first occurrence passed (and even failed
  creation for far-out first occurrences); the plan dialog pre-checks the
  server's BYTE text caps inline (the browser maxLength counts characters
  only, so e.g. a 128-character umlaut name hit a save-time 400 —
  purpose/notes gain their maxLengths, shared constants live in
  `lib/planning/limits.ts`); the plan card's muted line no longer renders
  a dangling " · " for the category shown in the chip row; the forecast's
  all-accounts anchor caveat (single latest snapshot _batch_, inherited
  from the analytics balance KPI — understates multi-account users, exact
  when account-scoped) is now documented in planning.md; raw-RRULE edits
  in the plan dialog are validated with the exact server-side
  `validateRrule` pass — an invalid raw rule disarms the dialog inline
  (same surface as a builder-mode error) instead of staying saveable until
  the save-time 400 toast, and the Wiederholung select tracks the raw
  text's FREQ, so clearing the raw RRULE (→ one-off plan) reads as
  "Einmalig" instead of the stale pre-edit frequency; the deep-linked
  transactions focus view (`?tx=<id>`) disables its pager — the id lookup
  ignores page state, so the controls were clickable no-ops around a stale
  "N / 1" indicator that now reads "Fokus"; the dashboard's "Geplant
  einblenden" surfaces a failed forecast read with the ErrorState + retry
  pattern instead of silently dropping the overlay;
  `GET /api/transactions/calendar` gained the same ±60-month window
  distance cap as `GET /api/plans/occurrences`, so the two /planung window
  reads fail together under their shared ErrorState (regression-tested);
  the plan dialog's create/update fan the mutation out to the planning
  caches (`invalidatePlans`) — the dialog path was the one mutation entry
  point without the fan-out, and with the app's `staleTime` +
  no-refetch-on-window-focus the board, calendar chips, forecast card and
  dashboard overlay kept showing pre-mutation data until the affected
  queries remounted (regression-tested); a stored ordinal BYDAY the
  Wiederholung picker can't display ("−2SU" … — beyond the picker's
  1–5/"letzte") routes to the raw-authoritative RRULE field instead of
  rendering an empty pattern select, and "5." (5th weekday) became a
  picker item so stored 5FR plans display their pattern (round-trip and
  faithfulness-gate tested); planning.md's next-date ladder description
  matches the shipped five rungs (400 → 147 000 days).

## v1.20.0

### Changed

- **dashboard — balance timeline promoted to full-width hero chart,
  Monatssaldo dropped**: `Monatssaldo` and `Monatlicher Cashflow` both
  visualized the same per-month net data (once as a standalone bar chart,
  once as the net line inside the cashflow chart), so the standalone chart
  is removed and `Kontostand über Zeit` moves to the top of the dashboard
  as a full-width hero chart (`@min-[1024px]:col-span-3`) (#86). Frontend:
  chart order is now Balance → Cashflow → Top Categories; `SavingsChart`,
  `savingsConfig` and `fullMonth` deleted, `BalanceChart` spans 3 columns
  (components/analytics-charts.tsx). Engine/API: the savings-history query,
  the `SavingsHistory` interface and the `savingsHistory` field of the
  analytics response are removed (`buildTimeScopedWhere` kept — it still
  scopes the balance timeline; lib/analytics/engine.ts). Tests: the
  savings-history fixture suite is gone; the layout regression now asserts
  the hero chart's `@min-[1024px]:col-span-3`. Docs updated (ADR-0022 left
  as historical record).

## v1.19.1

### Security

- **docker — node base image pinned to `node:24.22.1-bookworm-slim`**
  (CVE-2026-111497, HIGH: out-of-bounds write in Node's bundled Brotli
  decoder, remote code execution possible when app code decompresses
  attacker-controlled `Content-Encoding: br` payload — exposure here is
  `undici`/`fetch` fetching external content, e.g. the `/api/llm/*` calls).
  Both Dockerfile stages (`builder` and runtime) previously used the
  floating `node:24-bookworm-slim` tag, so an image built or layer-cached
  before the 2026-10-21 Node.js security releases contained a vulnerable
  24.x runtime. Now pinned to 24.22.1 (first 24.x with the fix; the in-file
  comment records why, Dependabot continues to raise minor/patch bumps on
  top of the pinned tag). No application code changes.

## v1.19.0

### Added

- **agent — `calculator` tool for arithmetic in chat**: the agent can now
  evaluate arithmetic expressions (Grundrechenarten, `^`, parentheses,
  decimal fractions — where `%` is the division remainder, modulo, NOT a
  percent sign; percentages are formed via multiplication/division) through
  a third registered tool (`calculator`,
  lib/agent/tools/calculator.ts) instead of doing multi-step money math in
  its prose — cent→euro conversion, subtotal splits and percentage
  arithmetic become verified computations. The tool is stateless and
  user-independent (no money data flows through it; `ctx.uid` scoping is a
  no-op by design). Evaluation runs through expr-eval's own parser — never
  `eval`/`Function` — narrowed to pure arithmetic: the parser instance's
  non-arithmetic operator groups, built-in functions and constants are
  pruned (expr-eval otherwise ships `random()`, `PI`, comparisons, string
  concatenation etc. with no opt-out), so variables, function calls, and
  comparisons all reject; non-finite results (division by zero →
  `Infinity` under JS arithmetic) are refused rather than handed back as
  a believable number. Registry-only wiring:
  `agentTools` (lib/agent/tool-registry.ts) gained one entry — wire format,
  dispatch and the system prompt's tool list derive from the registry, so
  no changes in the loop, executor, route or UI. Covered in agent-tools
  tests (wire shape, precedence/parentheses, decimals, invalid args and
  non-finite rejection).

## v1.18.1

### Fixed

- **dropdown popups — labels no longer overflow into the check mark**: the
  transaction table's column dropdown pinned its popup to the trigger
  button's width (`w-(--anchor-width)`), so long single-word column labels —
  `Verwendungszweck`, `Mandatsreferenz`, `Kundenreferenz` — could neither
  wrap nor shrink below their intrinsic width and rendered underneath the
  absolutely-positioned check icon (`right-2`). `DropdownMenuContent`
  (`components/ui/dropdown-menu.tsx`) now grows with its content (`w-max`),
  floored at `max(var(--anchor-width), 8rem)` so trigger-shaped menus are
  unchanged, and is capped at Base UI's available viewport space so very
  long menus can't leave the screen. It also reserves the scrollbar gutter
  (`[scrollbar-gutter:stable]`): `w-max` sizes the popup before a scrollbar
  appears, and Firefox (unlike Chromium) then squeezes item content by the
  scrollbar width, pushing long labels into the check icon again in tall
  scrollable menus. Covers the same latent bug in the filter bar's category
  dropdown. On overlay-scrollbar platforms (macOS, Firefox macOS) the
  gutter reservation has no effect.

- **agent panel — page width responsiveness with the dock open**: the docked
  chat was a fixed 280–720 px column next to `<main>` without `min-w-0`, so
  once the dock took enough width the flexible column refused to shrink below
  its content's intrinsic width and the page overflowed with a horizontal
  scrollbar instead of reflowing — resizing the window looked frozen. `<main>`
  now carries `min-w-0` and is a Tailwind `@container`: the page grids (KPI
  row, dashboard charts, transaction detail list, imports page) moved from
  viewport breakpoints (`sm:`/`lg:`) to container queries
  (`@min-[640px]:`/`@min-[1024px]:`) — same intent, but these measure
  `<main>`'s content
  box and thus fire ~2rem (px-4) later than the old viewport thresholds —
  so content reflows against the width
  actually left of the dock. The dock itself is additionally capped at
  `100vw − 320px` — a persisted 720 px can no longer squeeze the page to a
  sliver on a small window (window resizes re-apply the cap with no listener
  and leave the persisted width untouched; drag/keyboard resize clamp to
  and commit the same limit, so the persisted width follows the user's
  last interaction).

## v1.18.0

### Added

- **transactions — expandable detail row**: every row gets a chevron toggle
  column; clicking the row (or the focusable chevron button, with
  `aria-expanded`) opens an inset panel below it with the full values as a
  definition list — full Vertragspartner and Verwendungszweck
  (`whitespace-pre-wrap` for structured multi-line SEPA purposes), mono
  IBAN/Gläubiger-ID/Mandats-/Kundenreferenz (hidden when empty), plus
  Typ/Konto/Kategorie. Accordion semantics (one expanded row at a time);
  expansion resets on page/sort/filter change; text-selection drags and
  double-clicks don't toggle the row
  (`hooks/use-row-activation.ts`); the `Kategorie zuweisen` button no
  longer toggles the row; the native Verwendungszweck tooltip was removed
  (superseded by the detail row).

### Fixed

- **transactions — hydration mismatch on column visibility**: the persisted
  column config was read from `localStorage` inside a lazy `useState`
  initializer, so a changed config diverged from the SSR HTML and broke
  hydration. Column visibility now lives in a module-level
  `useSyncExternalStore` store (`components/table-columns.ts`) with a fixed
  server snapshot — the browser picks up the persisted config right after
  hydration. Cross-tab `storage` events sync columns across tabs (new), and
  failed `localStorage` writes (Safari private mode, quota) fall back to an
  in-memory override so the toggle keeps working.

## v1.17.0

### Added

- **query_data — read-only query DSL for the agent**: the agent can now ask
  arbitrary read-only questions about the user's financial data through a
  flat JSON query tool instead of only the one preset
  (`get_category_totals`). Freedom and safety are separated by design: the
  model freely picks table/column/filter/aggregation combinations, while a
  whitelist catalog (tables, columns, join edges, value kinds) is the only
  source of identifiers — the compiled statement is one SELECT whose
  identifiers render from catalog constants and whose values are bound
  parameters; `user_id = <session uid>` is forced into the WHERE and into
  every join's ON clause and `user_id` is not an addressable column.
  Reads run through a second better-sqlite3 connection opened
  `readonly: true` (+ `PRAGMA query_only`), so even a compiler bug cannot
  write. DSL: `table`/`select`/`where` (AND)/`whereAny` (OR group)/
  `aggregate` (sum/count/avg/min/max)/`groupBy`/`having` (on aliases)/
  `orderBy`/`limit` (clamped to 100, default 20) with ops
  `eq ne gt gte lt lte contains like in isNull notNull` (`contains` escapes
  LIKE wildcards; both are ASCII-case-insensitive); joins (`category.name`, `account.name`, `batch.*`,
  `label.*`) are inferred from dotted refs to whitelisted FK edges;
  derived columns `booking_month`/`booking_year` make per-month/year
  answers expression-free. Results report `limited` + `totalMatching` when
  cut, long cells capped at 200 chars, and all failures surface as
  `{"error": …}` prompts for self-correction. The system prompt gains a
  schema/DSL reference block generated from the same catalog (only when
  the tool is advertised). lib/agent/query/*, lib/agent/tools/query-data.ts;
  ADR-0034.

## v1.16.0

### Added

- **Markdown rendering in the agent chat**: every message text — assistant
  answers (persisted and streamed), the "Denkprozess" trace, user bubbles,
  and tool chip payloads — renders through a shared markdown renderer
  ([components/agent/markdown.tsx](components/agent/markdown.tsx)). GFM
  tables/task lists/strikethrough via `remark-gfm`, typed hard line
  breaks preserved via `remark-breaks`, and fenced code blocks highlight
  when the fence declares a language (`rehype-highlight`, no
  auto-detection so streamed prose is never mis-colored) with token
  colors built on the app's own oklch palette (light and dark). Raw HTML
  renders as inert escaped text (react-markdown default, no
  `rehype-raw` — the markup never becomes a DOM element), with
  block-level HTML lines wrapped in their own paragraph so an HTML-only
  streamed frame keeps the cursor's last-child anchor; images are
  disallowed entirely (chat is text formatting, not media —
  model-generated `![](...)` never fetches a remote host), links open in
  a new tab with `noopener`, and `javascript:` URLs are neutralized by
  the default URL transform. Headings stay clamped to bubble size (no
  browser-default 2em blow-up). Single newlines render as line breaks so
  typed message formatting keeps the look it had as plain text.

## v1.15.0

### Added

- **App-wide LLM agent panel** (ADR-0033): a right-side chat dock toggled
  from the header — docked and resizable (280–720 px) on desktop, a
  full-screen overlay on mobile, with open state and width persisted in
  `localStorage`. It reuses the same llama-server as the labeler but
  through the **native OpenAI tools API**: streaming chat
  (`temperature 0.3`, reasoning-aware `reasoning_budget_tokens`) with a
  German system prompt. The tool loop runs at most
  `AGENT_MAX_TURNS` (5) rounds, ends on a tools-free final round, and
  turns tool errors into JSON results the model can react to.
- **Extensible tool registry**
  ([lib/agent/tools.ts](../lib/agent/tools.ts)): one entry per tool; the
  first is the read-only `get_category_totals` (per-period per-category
  sums, integer cents, always scoped to the **speaker's** uid — also in
  shared threads).
- **Multi-user chat threads in SQLite** (`chat_threads` /
  `chat_thread_members` / `chat_messages`: per-thread seq ordering, role
  CHECK, FK cascade) with **invite-based sharing** via the new
  `GET /api/users` directory — roles `owner | member | invited`, preview
  after join, owner rename/uninvite/delete (cascades), member leave,
  invited decline; foreign/unknown threads always 404 (no existence
  leak).
- **SSE chat endpoint** (`user` / `delta` / `reasoning` / `round` /
  `tool_call` / `tool_result` / `done` / `error` frames): the route
  persists the user message, tool rows, and assistant
  content/reasoning per event; `reasoning_content` is shown as a
  collapsible "Denkprozess" but never replayed into loop history, and
  the `error` frame distinguishes a mid-turn thread deletion from
  infrastructure failures. Keepalive ping frames cover silent LLM
  waits, and the stored chat doubles as a replayable per-round
  transcript: the history window reads the last 128 rows, fits them to
  the `LLM_CTX`-derived char budget, and anchors at the oldest user
  message inside the budget so the prompt never starts mid-tool-protocol.

### Changed

- **Layout is full-bleed by design**: composing the dock dropped the
  centered `max-w-7xl` cap — header and `<main>` render full-width, dock
  open or closed ([app/layout.tsx](../app/layout.tsx)).
- **Shared SSE plumbing extracted to
  [lib/llm/sse.ts](../lib/llm/sse.ts)** (CRLF frame separators
  preserved and regression-tested); the label path is behaviorally
  unchanged.

## v1.14.1

### Fixed

- **LLM requests no longer die at undici's fixed 300 s timeout**: the client
  now sends `stream: true` and consumes the SSE response
  ([lib/llm/client.ts](../lib/llm/client.ts)). Non-streaming requests wait
  for the entire batch to generate before the first response byte, and
  Node's fetch (undici) enforces its own 300 s `headersTimeout` /
  `bodyTimeout` that `LLM_TIMEOUT_MS` cannot extend — any batch slower
  than 300 s to first byte failed with `UND_ERR_HEADERS_TIMEOUT`. With
  streaming, llama-server flushes SSE headers immediately and emits one
  delta per token, so undici's timers reset chunk by chunk;
  `LLM_TIMEOUT_MS` (via `AbortSignal.timeout`, spanning fetch and body
  read) is the deadline while generation is active. Only `delta.content`
  accumulates (`reasoning_content` deltas are ignored, mirroring the
  non-streaming `message.content` semantics), a non-SSE response still
  parses via a fallback, and the retry taxonomy is unchanged — timeouts
  (including mid-stream aborts) are never retried. A stream that stalls
  outright instead hits undici's 300 s `bodyTimeout`
  (`UND_ERR_BODY_TIMEOUT`), which stays classified as a transient
  network error and is retried.

## v1.14.0

### Added

- **Dedicated Transaktionen tab with URL-synced filters**: the full
  transaction table moved off the Dashboard to `/transactions`
  ([ADR-0026](adr/adr-0026-server-side-table.md)); the Dashboard keeps
  analytics (KPIs + charts) only. Filter state round-trips through the
  query string (`filtersToParams`/`paramsToFilters` in
  [lib/filters.ts](../lib/filters.ts)), so filtered views are shareable
  and bookmarkable; `router.push` gives every filter state its own
  history entry. A synchronous local mirror of the URL filters plus an
  echo-key registry ([lib/url-echo.ts](../lib/url-echo.ts)) make rapid
  filter changes compose without racing async navigations, while
  external changes (back/forward, shared links) are adopted.
- **All schema fields as table columns**: Buchung, Wertstellung, Status,
  Vertragspartner, Verwendungszweck, IBAN, Typ, Konto, Kategorie,
  Label-Status, Gläubiger-ID, Mandatsreferenz, Kundenreferenz, Betrag —
  with a persisted column-visibility toggle (Spalten dropdown,
  `localStorage`). Sorting gained a Wertstellung and Status field plus
  an always-visible Sortierung dropdown chip that shows the active
  sort and direction and can sort by hidden columns.
- **Extended filter bar**: multi-select categories (checkbox dropdown),
  account filter (Alle Konten), Status (Gebucht/Nicht gebucht/Alle),
  and Label-Status (offen/gelabelt/fehlgeschlagen), shared by Dashboard
  and transactions tab.

### Changed

- **Balance/savings KPIs are scope-isolated**: `buildTimeScopedWhere`
  ([lib/analytics/engine.ts](../lib/analytics/engine.ts)) builds the
  time-scoped queries from an allowlist (user + booked rows + optional
  account + date bounds) instead of stripping content filters off the
  flow filters — new content filters can no longer leak into
  balance/savings. Flow aggregates (cashflow, categories, transaction
  count) still react to every filter including Status.

### Fixed

- **Server/client filter parsing parity**: `parseFilters` rejects
  non-positive `accountId`, matching the client.
- **Dropdown menus render in popup content** and URL filter updates
  compose correctly (echo keys are evicted by TTL so pending echoes are
  never dropped; stale keys from interrupted navigations expire).
- **Accounts fetch surfaces failures** via React Query (`res.ok` check)
  instead of silently rendering an empty list.

## v1.13.0

### Added

- **LLM reasoning on by default**: `make llm` passes `--reasoning on` and
  `--reasoning-budget` (capping the trace server-side; default 1024; only
  `on`/`off` are supported — `auto` is rejected). The app defaults to
  `LLM_REASONING=true` / `LLM_REASONING_BUDGET` (1024) and reserves
  thinking tokens in `max_tokens` — the trace shares the completion
  budget, so without the reserve the JSON truncates deterministically.
  Both sides must stay in sync on on/off: disabling thinking requires
  `make llm LLM_REASONING=off` **and** `LLM_REASONING=false` in the app
  env. All defaults are sized for the reference machine (Ryzen 5 5600X,
  32 GB RAM, RTX 3070 Ti; 27B Q4_K_M at ~3.5–4 t/s); `LLM_TIMEOUT_MS`
  rises from 300 s to 900 s so the theoretical worst-case reasoning
  request fits (timeouts are never retried). **Upgrade note:** a
  deployment that pinned the previously documented default
  `LLM_TIMEOUT_MS=300000` keeps that value — a default-batch reasoning
  request needs far more than 300 s on the reference machine and
  timeouts are never retried; raise or remove the pin.
  `LLM_REASONING=true` with `LLM_REASONING_BUDGET=0` is rejected at
  startup (Makefile and app config) — budget `0` is llama-server's
  end-thinking-immediately (use `LLM_REASONING=false`), and as a
  client-side reserve `0` would let the trace eat into the label JSON.
  Uncapped thinking (`-1`) is not supported either: the client cannot
  reserve `max_tokens` for an unbounded trace.
- **Budget sync is enforced per request**: the client pins
  llama-server's thinking cap (llama.cpp's `reasoning_budget_tokens`
  request field, which overrides the `--reasoning-budget` flag) to its
  own `LLM_REASONING_BUDGET` on every reasoning-enabled request — the
  trace can no longer outgrow the reserve, no matter what flags an
  already-running server or Docker container was started with. The
  server's `--reasoning-budget` becomes a fallback cap for non-app
  traffic; `make llm` now also notes a budget mismatch against the app
  env (`.env`) the same way it does for on/off.
- **Both reasoning spellings accepted everywhere**: `LLM_REASONING`
  accepts `true`/`false` and `on`/`off` on both sides (app config and
  Makefile, normalized onto the boolean / llama-server's `on`/`off`
  respectively), so an exported `LLM_REASONING=on` no longer pauses the
  label worker with a config error while the server starts fine.

## v1.12.0

### Changed

- **Favicon matches the Geldlage brand**: `app/icon.svg` now uses the
  neutral-gray + emerald-green theme palette (the chart greens on a neutral
  gray tile, `#333333`) instead of the pre-rebrand slate/sky-blue colors. The
  same mark appears in the header wordmark and the mobile nav sheet
  (`components/logo.tsx`).

## v1.11.0

### Changed

- **Rebranded to Geldlage** (formerly DKB Analytics): the tool is becoming
  bank-agnostic with many data sources and ML/LLM functionality at its core,
  so the bank-specific name no longer fits. Product surfaces (UI, docs,
  Docker image `ghcr.io/j-stechmann/geldlage`, OIDC client id, compose
  project, GHCR path) and internal identifiers (cookie names, `globalThis`
  singleton keys, default DB path `./data/geldlage.db`) are renamed; the
  DKB CSV import stays fully compatible.
  - **Database file adoption**: the default DB file used to be
    `./data/dkb.db`. On first boot after the upgrade, an existing `dkb.db`
    (with its WAL sidecars) in the database directory is renamed to the
    configured `DATABASE_PATH` (`./data/geldlage.db` by default, Docker:
    `/app/data/geldlage.db`) so the upgrade keeps all data with no manual
    step. An existing target file is never overwritten; deployments that
    set `DATABASE_PATH` explicitly and already have a DB there are
    unaffected. Pre-rebrand data lives on in `dkb.db` only when a target
    file already exists.
  - **User identity migration**: users are keyed on `(issuer, subject)` and
    the rebrand changed the default dev issuer URL
    (`…/application/o/dkb-analytics/` → `…/application/o/geldlage/`), so a
    pre-rebrand login would JIT-provision a fresh empty workspace while the
    data stayed owned by the old issuer. When `LEGACY_OIDC_ISSUER_URL` is
    set (dev `.env` ships the value) and every user in the DB matches that
    legacy issuer, `users.issuer` is rewritten to the configured
    `OIDC_ISSUER_URL` once at startup; a same-subject duplicate created
    under the new issuer in the meantime is merged into the pre-rebrand
    user. Deployments with a third, unrelated issuer are skipped (loud
    warning) so a live multi-provider setup is never re-pointed.
  - **Sessions are invalidated by the upgrade**: the session cookie was
    renamed (`dkb_session` → `geldlage_session`) and the session JWT's
    audience changed (`dkb-csv-export-analysis` → `geldlage`), so all
    pre-rebrand cookies fail verification and every user simply logs in
    again — no stale-cookie handling was added, none is needed.
  - **Dev OIDC stack migration (automatic)**: the compose project rename
    (`dkb-analytics-dev-oidc` → `geldlage-dev-oidc`) would let a
    still-running pre-rebrand stack keep holding port 8081, making `make
oidc` silently provision into the old project's Authentik. `make oidc`
    now tears the old project down automatically before starting the
    renamed stack (no-op when absent); the orphaned
    `dkb-analytics-dev-oidc_authentik-db` volume is left in place —
    `docker volume rm dkb-analytics-dev-oidc_authentik-db` removes it.

## v1.10.1

### Security

- **Client-settable `X-Forwarded-*` headers are only trusted with
  `APP_ORIGIN` set**: those headers are not fetch-forbidden, so on a
  directly-exposed app (no proxy stripping them) an attacker page could set
  them via `fetch()` and pass trust checks built on them. Two places
  aligned on the same rule — `APP_ORIGIN` is the operator's declaration
  that a proxy fronts the app and normalizes those headers; the plain
  `Host` header and the request's own protocol stay trusted in all cases:
  - The CSRF guard (`assertSameOrigin`) no longer honors
    `X-Forwarded-Host`/`X-Forwarded-Proto` without `APP_ORIGIN` — an
    attacker page could otherwise mirror its `Origin` to a forged
    `X-Forwarded-Host` and pass the origin check with the session cookie
    attached on browsers without Fetch Metadata (`Sec-Fetch-Site` absent,
    e.g. Safari < 16.4; SameSite=Lax does not close this — Lax cookies ride
    same-site requests).
  - `sessionCookieOptions` no longer reads `X-Forwarded-Proto` without
    `APP_ORIGIN` — a forged `https` value could otherwise flip the
    `Secure` attribute as a cookie-overwrite gadget (an attacker-set
    `http`/absent value could also strip it; both directions now require
    the proxy declaration).
  - Corrected the guard's `Origin: null` rationale (residual risk: same-site
    attacker content on a browser without Fetch Metadata — where Lax does
    not hold the line).

### Fixed

- **Logout (and every mutating request) rejected with 403
  `cross_site_request_rejected` when browsing via a LAN IP or hostname**:
  the CSRF guard (`assertSameOrigin`) built its allowed-origin set from
  `APP_ORIGIN` and `request.url` — but the Next dev server normalizes
  `request.url` to the server's initialized hostname (`localhost`), so
  requests arriving via any other Host carried an Origin that could never
  match. The guard now also accepts the origin derived from
  `X-Forwarded-Host`/`Host` (+ `X-Forwarded-Proto`) as browser-facing
  origin, and compares hosts case-insensitively (`URL.origin` lowercases
  the Host-derived host while browsers echo `Origin` in the case used to
  reach the server — `http://Desktop:x` vs `http://desktop:x` used to
  fail). Unparseable `Origin` headers fail closed. Attacker pages still
  can't pass (their `Origin` never equals the app's `Host`), and
  cross-site `Sec-Fetch-Site` stays blocked.
- **Chromium's post-OIDC `Origin: null` form POSTs**: after the OIDC login
  round-trip, Chromium (observed in 153) can send a form POST from the
  app's own page with the literal `Origin: null` alongside
  `Sec-Fetch-Site: same-origin` — the navigation initiator is treated as
  opaque even though the document origin is the app's. The guard now
  accepts `Origin: null` **only** when `Sec-Fetch-Site` is `same-origin`
  or absent (both browser-generated and unspoofable); `Origin: null` with
  cross-site/same-site fetch metadata (sandboxed attacker iframes) stays
  rejected. Reproduced end-to-end with real Chromium (login → Abmelden →
  post-logout redirect) before and after the fix.

### Changed

- **`make dev` cleans up after itself**: on exit (Ctrl-C included) it now
  tears down the dev OIDC provider containers it started
  (`docker compose down` — the `authentik-db` named volume keeps the
  provisioned client, so the next start re-creates containers from the
  _current_ `compose.dev.env` instead of serving stale volume state).
  Pre-existing llama-server or OIDC stacks are left alone (marker files
  track what the invocation started), so parallel sessions don't steal each
  other's services. `make stop` removes the OIDC containers too;
  `oidc-stop` is now an alias of the new `oidc-down` (`compose stop` →
  `compose down`, volume kept).
- **`make dev`'s exit trap no longer tears down services it didn't start**:
  the trap's llama-server branch called `make stop`, whose new `oidc-down`
  step also removed a _pre-existing_ OIDC stack — contradicting the
  "left running after exit" message. The trap now uses the new pidfile-only
  `llm-kill` target (no OIDC coupling, no failing health check), so a
  pre-existing stack is always left running. `make stop` keeps its
  interactive both-services teardown (explicit intent), but a failed
  llama-server health check now only reports leftovers instead of aborting
  before `oidc-down` runs.
- **Stale marker files can no longer hijack the next `make dev`**: when a
  previous run died without its trap (SIGKILL, power loss),
  `/tmp/llama-server.managed` / `/tmp/geldlage-oidc.managed` lingered and the
  next run would tear down services it didn't start. `make dev` (and
  `make llm`) now clear a marker whenever the service it references is
  healthy at startup, so markers only ever describe _this_ run's services.
- **`make llm-stop` no longer stops the dev OIDC provider**: it was an
  alias of `stop`, which gained the `oidc-down` step — restarting only the
  LLM side unexpectedly tore down the IdP mid-session. `llm-stop` is now a
  llama-server-only teardown (`llm-kill` + leftover report); full teardown
  remains `make stop`.

## v1.10.0

### Breaking

- **Multi-user migration starts fresh**: tables pre-dating the users table
  (accounts, import batches, transactions, categories, label rules) are
  dropped and recreated user-shaped on startup — pre-multi-user rows cannot
  be attributed to an owner, so all existing data is discarded. The
  migration is idempotent across hot reloads (ADR-0005). See
  `docs/adr/adr-0032-multi-user-oidc.md`.

### Added

- **Mandatory OIDC login with per-user data isolation** (supersedes the
  no-auth posture of ADR-0031): generic OIDC provider via issuer discovery
  (`openid-client`) with PKCE + state + nonce, a `jose`-signed HS256 session
  cookie, auth routes under `/auth/*`, and a `proxy.ts` gate (Next 16
  middleware convention) that redirects pages to `/auth/login` and returns
  401 JSON for `/api/*` (the health endpoint stays open for the Docker
  healthcheck). Users are JIT-provisioned on first login keyed on
  (issuer, subject); no allowlist.
- **Per-user isolation**: `user_id` stamped on accounts, import batches,
  transactions (denormalized), categories and label rules. All 17 route
  handlers, the import pipeline, the label worker and analytics are
  user-scoped; account uniqueness moved to (user_id, iban) so the same IBAN
  can exist per user; learned rules and prompt label vocabulary are per
  owner. UI: header user chip + logout, `/api/me` whoami, and an `apiFetch`
  wrapper that redirects to `/auth/login` on 401.
- **Dockerized dev OIDC provider**: throwaway Authentik stack
  (`make oidc`, compose.dev.yaml) auto-started by `make dev` / `make app`,
  provisioned idempotently via API; config survives restarts in a named
  volume. New targets `oidc-stop`, `oidc-status`, `oidc-logs`.
- **Mobile navigation**: hamburger nav sheet replacing the overflow header;
  the LLM badge shows the full label only from the `md` breakpoint.

### Security

Security-audit follow-ups (threat model: a guest on the same network):

- **CSRF guard on every mutating route**: all non-GET API handlers and the
  auth endpoints now share `assertSameOrigin` (lib/auth/guard.ts) —
  `Origin`/`Sec-Fetch-Site` must match the app origin or the request gets
  `403 {"error":"cross_site_request_rejected"}`. Closes the same-site
  cross-origin gap that `SameSite=Lax` alone leaves open. `/auth/logout` was
  refactored onto the same helper (error code renamed from
  `cross_site_logout_rejected`). Note this is fail-closed: a reverse-proxied
  deployment without `APP_ORIGIN` now gets 403 on every mutating call (the
  internal origin can never match the browser's public Origin) — previously
  only `/auth/logout` rejected such requests; set `APP_ORIGIN` when proxying.
- **Plaintext-HTTP warning at startup**: when `APP_ORIGIN` is set and not
  HTTPS the boot logs a loud warning — bank data over plain HTTP is readable
  and script-injectable by anyone on the network. Docs now state TLS is
  mandatory for any non-localhost deployment.
- **Security headers**: `Content-Security-Policy` (no cross-origin scripts,
  `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` on all routes;
  `Cache-Control: no-store` on `/api/*` and `/auth/*`.
- **Constant-time OIDC state comparison** (`node:crypto.timingSafeEqual`) in
  `/auth/callback` instead of `===`.
- **Cookie readers hardened**: malformed percent-encoded cookie values now
  resolve to null (401/redirect) instead of throwing a 500
  (`getSession`, `cookieValue`).
- **Dev IdP hardening**: compose.dev.yaml binds Authentik to `127.0.0.1`
  only and reads credentials from the gitignored `compose.dev.env`
  (template: `compose.dev.env.example`, created on first `make oidc`) —
  previously the bootstrap password/token were committed in the compose
  file and the admin UI listened on all interfaces.
- Startup reminder to keep `data/` and `.env` owner-only on multi-user
  hosts (umask 077 / chmod 600).

## v1.9.1

### Fixed

- `GET /api/labels` reported wrong `ruleCount` values (usually 0): the
  correlated subquery's unqualified `"id"` resolved to the inner
  `label_rules.id` instead of the outer `categories.id` (SQLite column
  shadowing). The reference is now table-qualified, and a regression test
  seeds two rules to catch any future masking.

## v1.9.0

### Changed

- Git-flow is now in place: `develop` is the integration branch for all work
  (features, fixes, Dependabot PRs); `master` holds only released code.
  See `CONTRIBUTING.md`.

### Added

- Categories now have **permanent, unique** colors, stored in a new
  `categories.color` column (unique index). Colors are allocated at creation
  (curated 12-color oklch palette first, then procedural unique colors) and
  backfilled deterministically for existing DBs on startup. The chart, table
  badges, filter dots, and label lists all render the stored color; the old
  id-hash remains only as a legacy fallback.

## v1.8.0

### Breaking

- Label rules are now keyed on the strict triple (payer, payee, counterparty IBAN) instead of (IBAN, name key). The `label_rules` table is rebuilt on startup, which **discards all previously learned rules**. Rules regenerate automatically as labels are re-assigned; there is no other visible signal of the loss.
