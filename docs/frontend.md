# Frontend

Every page is a **client component**: the entire UI is a live dashboard
driven by filters, polling, and toasts, with no server-rendered data
([ADR-0023](adr/adr-0023-client-components-react-query.md)). The only Server
Component is `app/layout.tsx` (static shell hosting client islands: nav,
LLM health badge, theme toggle). This Next.js version has breaking changes
vs. common knowledge — the vendored docs under
`node_modules/next/dist/docs/` are the authoritative reference (see
`AGENTS.md`).

## Stack

| Piece      | Choice                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Framework  | Next.js 16.3.3, React 19 ([ADR-0001](adr/adr-0001-bun-toolchain.md))                                                           |
| Styling    | Tailwind v4 (CSS-first, no config file), oklch palette, `font-serif` body                                                      |
| Components | shadcn/ui "base-nova" style on **`@base-ui/react`** — not Radix ([ADR-0024](adr/adr-0024-ui-stack-tailwind-shadcn-base-ui.md)) |
| Data       | React Query 5 ([ADR-0023](adr/adr-0023-client-components-react-query.md))                                                      |
| Charts     | Recharts 3 in shadcn `ChartContainer`, custom zoom hook                                                                        |
| Toasts     | sonner, one toast per HTTP outcome, German copy                                                                                |
| Icons      | lucide-react                                                                                                                   |
| Theming    | next-themes (class attribute, system default)                                                                                  |

Provider nesting (`components/providers.tsx`): ThemeProvider →
QueryClientProvider → TooltipProvider → ActiveImportProvider →
DragDropProvider → children + ImportProgressPill + Toaster. The agent panel
([ADR-0033](adr/adr-0033-agent-panel-tool-loop.md)) deliberately adds **no
provider**: its open/width state lives in a module-level
`useSyncExternalStore` store (see below).

## Agent panel

The app-wide "KI-Chat" ([ADR-0033](adr/adr-0033-agent-panel-tool-loop.md),
all in [components/agent/](../components/agent/)): an LLM chat panel with
native tool access to the user's own finance data, composed into
`app/layout.tsx` — `AgentToggle` sits in the header's right group
(before `LabellerHealthBadge`), and `AgentDock` is rendered as a flex sibling
next to `<main>` in the main content row, so pages and `AppNav` keep
their own markup. Composing the dock dropped the centered `max-w-7xl`
cap — the header row and `<main>` render full-bleed (`max-w-full`).
`<main>` additionally carries `min-w-0` (overrides the flex-item default
`min-width: auto`, which otherwise refuses to shrink below the content's
intrinsic width and overflows the page with a horizontal scrollbar once
the dock takes its space) and `@container` (the query container the page
grids key off — see below; its layout containment makes `<main>` the
containing block for `position: fixed` descendants, so fixed overlays must
be portaled or live outside main).

| Component / module                      | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/agent/agent-toggle.tsx`     | Header icon button (`aria-pressed`), toggles the dock via the shared panel store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `components/agent/agent-dock.tsx`       | Dock frame: resizable right column on md+ (`ResizeHandle` with pointer capture), full-screen overlay with close button below md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `components/agent/agent-chat.tsx`       | Slim orchestrator (~200 lines): composes the four UI parts around the two hooks; owns the mutation handlers with their German toasts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `components/agent/thread-bar.tsx`       | Thread bar: new-chat, inline rename, owner actions (rename/invite/delete), member leave, grouped dropdown (Meine Chats / Geteilte Chats / Einladungen, `ThreadSelect`/`ThreadGroup`)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `components/agent/message-list.tsx`     | Message list: persisted rows (`MessageRow`, `UserBubble`) in threadSeq order — per-round assistant rows interleave with their tool chips (chips-only rounds render no bubble), optimistic pending user message (retired once the authoritative view contains the `user`-frame-echoed row id), streaming view (frozen per-round bubbles + live bubble), pin-to-bottom, invited join panel + empty state; user bubbles render through the shared markdown renderer                                                                                                                                                                                |
| `components/agent/markdown.tsx`         | The ONE markdown renderer for all chat text (assistant content, Denkprozess, user bubbles, tool chip payloads): GFM + typed line breaks + `rehype-highlight` (`detect: false`) on `foreground`-opacity tokens so it works on both bubble variants; headings clamped to bubble size (no browser-default 2em), raw HTML renders as inert escaped text (block-level HTML lines get a root-level paragraph wrap, which also anchors the streaming cursor on HTML-only streamed frames), images disallowed (chat is text, no remote fetches), links `noopener`, streaming cursor injected via `::after` (STREAMING_CURSOR in `assistant-bubble.tsx`) |
| `components/agent/assistant-bubble.tsx` | The ONE assistant bubble: reasoning toggle ("Denkprozess"), tool chips, streamed/persisted markdown content — `streaming` only toggles defaults (thinking open, cursor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `components/agent/tool-chip.tsx`        | Tool round chip (name + expandable JSON args/result rendered through the markdown renderer: JSON payloads pretty-printed as a fenced `json` block, non-JSON fallback raw text stays a language-less fence), shared by persisted rows and the streaming bubble                                                                                                                                                                                                                                                                                                                                                                                   |
| `components/agent/chat-input.tsx`       | Composer: Enter sends (Shift+Enter / IME excluded), send button swaps to stop while streaming                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `components/agent/invite-dialog.tsx`    | Member-management dialog (owner): roster from `GET /invites` fetched only while open (owner row with "Besitzer" badge, joined "Mitglied", invited "Eingeladen") with per-row retract/remove for non-owners (disabled while that row's removal is in flight), plus the invite section — user directory fetched only while open minus the roster, checkbox multi-select                                                                                                                                                                                                                                                                           |
| `components/agent/use-agent-threads.ts` | Threads/detail React Query hooks (polling 15 s / 4 s paused while streaming), active-thread derivation with `localStorage` persistence (`geldlage.agent.thread`), lazy thread creation                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `components/agent/use-agent-turn.ts`    | Streaming turn state machine: optimistic user message (aligned via the `user` frame's persisted row id), SSE consumption into per-round segments — each `round` frame freezes the current prose/reasoning bubble and tool chips attach to the round that called them (mirroring the server's per-round persistence) —, abort handling (Stop button and unmount both abort), post-done invalidation of messages+threads (before dropping the optimistic state, so rows and bubbles swap in one commit)                                                                                                                                           |
| `components/agent/agent-api.ts`         | Typed fetchers for all agent endpoints, React Query keys (`THREADS_KEY`/`MESSAGES_KEY`/`MEMBERS_KEY`/`USERS_KEY`), `ApiError` on non-OK JSON (a 404 for invited preview surfaces as a query error, not fake data)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `components/agent/sse-events.ts`        | Client-side dispatch of the named SSE frames (incl. the bare `round` segment boundary), built on the SHARED parser `lib/llm/sse.ts` (`sseGenerator`) — the same generator the server-side loop client consumes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `components/agent/types.ts`             | Client-side DTOs mirroring the server contract (single source, no inline copies)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `components/agent/panel-state.ts`       | Module-level `useSyncExternalStore` store: `{open, width}`, persisted to `localStorage` (`geldlage.agent.open`/`.width`); SSR serves closed, lazy first-client hydrate (no provider, no layout flash)                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Dock behavior**: on md+ the panel is a sticky flex column pinned under the
header (`top-14`, `h-[calc(100svh-3.5rem)]`) whose width the user drags
between 280 and 720 px (clamped, persisted) — additionally capped at
`100vw − 320px` (CSS `max-w-[calc(100vw-320px)]` re-clamps on every window
resize without a listener; the same cap applies to drag/keyboard resize) so
the page keeps at least 320px beside the dock — roughly: `100vw`/innerWidth
include the vertical scrollbar, so the space beside the dock falls the
scrollbar's width short of the full 320px when the cap is active. Window
resizes never touch the persisted width (it restores when the window grows
again); drag/keyboard resize clamp to and _commit_ the cap instead. Below md
it renders as a fixed full-screen overlay. Page content is
**container-responsive**, not
viewport-responsive: `<main>` is a Tailwind `@container`, and its grids use
`@min-[640px]:` / `@min-[1024px]:` variants (same intent as the old `sm:` /
`lg:` viewport breakpoints — but container queries measure main's content
box, so they fire ~2rem (px-4) later) so layouts reflow against the width
actually left of the dock instead of crushing beside it. The chat is
streamed over SSE
(`delta`/`reasoning`/`tool_call`/`tool_result`/`done`/`error` frames):
content renders incrementally into a streaming bubble, the model's thinking
trace appears as a collapsible **Denkprozess** (open while streaming,
collapsed on the persisted row), and each tool round renders as a **tool
chip** (name + expandable JSON args/result). All message text — answers,
Denkprozess, user bubbles, chip payloads — renders as **markdown**
(`markdown.tsx`; fenced code highlights on an explicit language,
typed line breaks preserved, raw HTML escapes to inert text).

**Threads and invites**: the thread bar dropdown groups Meine Chats /
Geteilte Chats / Einladungen; selecting an invite shows the join panel
(Annehmen/Ablehnen) instead of messages — content unlocks exactly on join
(the API 404s for invited users, and `agent-api.ts` turns that 404 into a
query error so the join panel renders). Owners get rename, member
management (the `InviteDialog` shows the roster from
`GET /api/agent/threads/[id]/invites` — retract pending invites, remove
joined members — and invites from the user directory via `GET /api/users`,
filtering out roster members) and delete; joined members get leave;
invited users decline. Sending the first message can auto-create a
thread; the active thread id persists in `localStorage`.

**React Query keys** (same conventions as above):

| Query key                      | Fetches                            | Polling                                          |
| ------------------------------ | ---------------------------------- | ------------------------------------------------ |
| `["agent-threads"]`            | `/api/agent/threads`               | 15 s                                             |
| `["agent-messages", threadId]` | `/api/agent/threads/[id]/messages` | 4 s, **paused while streaming** (`retry: false`) |
| `["agent-members", threadId]`  | `/api/agent/threads/[id]/invites`  | — (only while the member dialog is open)         |
| `["agent-users"]`              | `/api/users`                       | — (only while the member dialog is open)         |

After a turn finishes (`done` or abort), the messages query is invalidated
and replaced by the persisted rows.

## React Query conventions

Global defaults: `staleTime: 5_000`, `refetchOnWindowFocus: false` —
deliberately conservative; only three things poll:

| Query key                            | Fetches                  | Polling                                                  |
| ------------------------------------ | ------------------------ | -------------------------------------------------------- |
| `["analytics", params]`              | `/api/analytics?…`       | — (invalidation-driven)                                  |
| `["transactions", params]`           | `/api/transactions?…`    | —                                                        |
| `["labels"]`, `["categories"]`       | label/category lists     | —                                                        |
| `["accounts"]`                       | account list (FilterBar) | —                                                        |
| `["label-rules", labelId]`           | rules per label          | —                                                        |
| `["label-rules", ruleId, "matches"]` | rule match preview       | live: refetched by invalidation while the dialog is open |
| `["imports"]`                        | import history           | 5 s                                                      |
| `["import", batchId]`                | active batch status      | **1 s, only while non-terminal**                         |
| `["llm-health"]`                     | LLM reachability         | 30 s                                                     |
| `["plans"]`                          | plan list                | —                                                        |
| `["plan-occurrences", params]`       | expanded occurrences     | — (fetched per visible calendar range)                   |
| `["forecast", params]`               | projection envelope      | — (fetched while the "Geplant" toggle is on)             |

- **Two-phase keys**: filter/page/sort state serializes into the key
  (`["transactions", params.toString()]`), so every combination gets its own
  cache entry and back/forward between filter states hits cache.
- **`placeholderData: prev => prev`** on table and analytics queries keeps
  content visible (dimmed) during refetches instead of flickering to
  skeletons.
- **Invalidation fan-out**: the labels page has a shared `invalidateAll()`
  hitting `labels`, `label-rules`, `transactions`, `analytics`, `categories`
  after any label/rule mutation; import completion invalidates
  `analytics`/`transactions`/`categories`/`labels`; retry invalidates
  `imports`/`import`/`transactions`/`analytics`/`categories`. Mutations are
  plain `fetch` calls in event handlers (no `useMutation`), each branch with
  its own toast.
- **Value-based filter reset**: the table resets `page` to 1 when filters
  change without an effect — `filterKey` (memoized `filtersToParams
(filters).toString()`) is compared against `lastFilterKey` state during
  render, and a difference triggers `setPage(1)`. Page changes alone don't
  re-fire it.

## Pages

### `/` — Dashboard

FilterBar (debounced text, date range, type, multi-select categories, account,
Status, Label-Status) → KPI row → three charts. No transactions table — it
lives on its own tab. Flow aggregates (cashflow, categories, transaction
count) react to every filter including Status; balance is
time-scoped by design: snapshots anchor an absolute booked account balance,
so content filters (q/type/category/labelStatus/**status**) are ignored
([lib/analytics/engine.ts](../lib/analytics/engine.ts),
`buildTimeScopedWhere`).

### `/transactions`

The full transaction table: **all schema fields as columns** (Buchung,
Wertstellung, Status, Vertragspartner, Verwendungszweck, IBAN, Typ, Konto,
Kategorie, Label-Status, Gläubiger-ID, Mandatsreferenz, Kundenreferenz,
Betrag) with a persisted column-visibility toggle (Spalten dropdown).
Hand-rolled on shadcn `Table` primitives with server-side everything:
pagination (fixed 25 rows), sorting (booking date, value date, status,
payee, amount), and filtering all happen in SQL; the client only
serializes state into the query string
([ADR-0026](adr/adr-0026-server-side-table.md)).

**Expandable detail row**: every row gets a narrow chevron column; clicking
the row (or the focusable chevron button) expands an inset panel below it
with the row's values as a definition list — full Vertragspartner and
Verwendungszweck (`whitespace-pre-wrap`, so structured multi-line SEPA
purposes read exactly as intended), IBAN, Gläubiger-ID and
Mandats-/Kundenreferenz (hidden when empty), plus Typ/Konto/Kategorie.
Accordion semantics (one expanded row at a time); the expansion resets on
page/sort/filter change (same value-based reset pattern as `page`). Rows
are deliberately **not** focusable — keyboard users toggle via the chevron
button (`Enter`/`Space`, `aria-expanded` + `aria-controls`). Row activation
is disambiguated from text-selection drags and double-clicks by
[hooks/use-row-activation.ts](../hooks/use-row-activation.ts) (one hook
instance feeds every row); the `Kategorie zuweisen` button stops
propagation so it never toggles the row.

**Deep-link focus** (`?tx=<id>`): bank chips on the /planung calendar link
here with only the row id in the URL. The table then switches its query to
the id lookup (`GET /api/transactions?id=<id>` — `queryTransactionById`,
user-scoped, ignores every other filter/pagination state, a miss is an
empty page, never a leak) and shows exactly that row — expanded,
highlighted (`data-focus` outline) and scrolled to on first sight
(render-time state adjustment with the value-based reset preserved; the
mount count fires too). The state's dead controls stay visibly off: the
sort dropdown, the pager (reading "Fokus" instead of a stale "N / 1") and
the column-header sort buttons — a header click would only mutate the sort
that resumes after leaving focus mode. Any filter edit drops the `tx`
param and returns the table to normal browsing. Regression-tested in
[tests/transactions-table-focus.test.tsx](../tests/transactions-table-focus.test.tsx)
(asserts the id query itself is what fetched the row).

**Column visibility store**
([components/table-columns.ts](../components/table-columns.ts)): a
module-level `useSyncExternalStore` store like
[components/agent/panel-state.ts](../components/agent/panel-state.ts) — SSR
and the hydration render deliver `DEFAULT_VISIBLE` (fixed server snapshot)
while the browser picks up the persisted config right after hydration (no
hydration mismatch, no `setState` in effect); cross-tab `storage` events
are picked up, and when a write throws (Safari private mode, quota) an
in-memory override keeps the toggle working for the session. The table
files split by concern: `components/transactions-table.tsx` is the slim
orchestrator (state, query, toolbar, pagination),
`components/transaction-row.tsx` renders the row pair (main row + detail
row with `TxRow` as single DTO source),
`components/assign-label-dialog.tsx` is the category dialog.

**URL-synced filters**: filter state round-trips through the query string
(`filtersToParams`/`paramsToFilters` in
[lib/filters.ts](../lib/filters.ts)), so filtered views are shareable and
bookmarkable. The page keeps a synchronous local mirror of the URL filters so
rapid changes compose instead of racing async `router.push` commits; own
URL updates are recognized via echo keys (timestamps of the query strings we
produced) and must not clobber newer local state — external navigations
(back/forward, shared links) are adopted. The page is wrapped in Suspense
per the Next 16 `useSearchParams` conventions. Category cells are badges
colored by the golden-ratio oklch palette; pending rows show a dashed "wird
kategorisiert" badge, failed/unlabeled rows "ohne Kategorie".

**Label assignment** (`AssignLabelDialog`): clicking a category cell opens a
searchable label list — single click selects, **double-click assigns
instantly**; a "…neu erstellen und zuweisen" action POSTs `{labelName}` (the
server creates the category and learns a rule in the same request).

**Sortierung dropdown**: sorting lives in an always-visible dropdown whose
button chip shows the active sort and direction; it also lets you sort by a
column that is currently hidden (sort headers render only on visible
columns). Column header clicks toggle desc/asc, switching columns starts
descending. Hiding the active sort column keeps the sort active — the chip
makes it discoverable.

### `/imports`

Dropzone (file picker + per-page drop), the active import card (stage,
two progress bars: rows `(imported+duplicate+updated)/total` and labels
`(done+failed)/total`), and history with a retry-labeling button for
exhausted rows.

**Drag-and-drop** works globally: `components/drag-drop-provider.tsx` listens
on window-level `dragenter/dragover/dragleave/drop` with a drag counter (to
survive child enter/leave noise) and shows a full-screen "CSV hier ablegen"
overlay; drops validate the `.csv` extension and POST the file as
`FormData`, then the shared `ActiveImportProvider` polls the new batch at
1 Hz until `completed`/`failed` and fires the invalidation fan-out + toast.

### `/labels`

Label CRUD (create form, rename dialog — which flips `origin` to `manual` —
and a delete dialog that spells out the consequences: transactions lose their
category and get re-labeled by the LLM, learned rules are removed). Each
label lists its learned rules with edit/delete plus the **apply dialog**,
whose match count is the live `["label-rules", ruleId, "matches"]` query so
the preview tracks concurrent changes while open. Rule dialogs are derived
from the live rules list (`rules.find(...)`), so a concurrently deleted rule
auto-closes its dialog instead of operating on stale state. Rules are only
created implicitly — by assigning labels in the transactions table.

### `/planung`

Geplante Transaktionen ([ADR-0035](adr/adr-0035-planned-transactions-rrule.md),
guide [planning.md](planning.md)) — all UI in
[components/planning/](../components/planning/):

| Component                               | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `components/planning/api.ts`            | DTOs, typed fetchers, React Query keys + hooks (`usePlans`, `usePlanOccurrences`, `useForecast`), mutation helpers, `describeRrule` (German RRULE summary)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `components/planning/plan-calendar.tsx` | `<EventCalendar>` composition: views `month` (default)/`agenda`, drags/resizes off (plans are edited via dialog, never dragged); THREE chip families — planned occurrences (full category color — muted when paused/matched, destructive when überfällig), real booked transactions (washed toward muted via `color-mix`, `•`-prefixed) and pending `Nicht gebucht` rows (washed further, hollow `◌` + dashed provisional outline via the chip's `chipVariant` local extension, mirroring the transactions table's pending language) — planned + bank chips fetched per visible range; `onRangeChange` feeds both queries; de locale + German i18n overrides. Click semantics: a PLAN chip opens its edit dialog; a BANK chip deep-links to `/transactions?tx=<id>` — the table queries the single row by id and expands, highlights and scrolls to it (see below) |
| `components/planning/plans-board.tsx`   | Calendar card + plan list (active/finished), pause/activate/finish/delete actions with toasts + delete-confirm dialog; forecast summary card (Guthaben heute / Projektion / geplant netto)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `components/planning/plan-dialog.tsx`   | Create/edit: amount (German text → cents via `parseGermanAmountToCents`), direction, counterparty/purpose/notes, account + category selects, and the **RRULE builder** — frequency (Einmalig/Täglich/Wöchentlich/Monatlich/Jährlich), interval, weekday chips, monthly day-list vs. weekday-ordinal (BYDAY=1FR = "1. Fr"), yearly month chips + pattern, end condition (Nie/Am Datum — noon-anchored, so the final day stays included/Nach N). A raw RRULE input is always visible (auto-synced from the builder; direct edits take over and validate exactly like the server via `validateRrule` — an invalid raw rule disarms save inline, and the Wiederholung select tracks the raw text's FREQ so clearing it reads as "Einmalig"), the live "Vorschau" shows the next ≤ 3 dates — computed by the SAME `rrule` engine as the server                          |

**Occurrence semantics**: the server expands (single source of truth); the
calendar renders and reports states — `erwartet` (chip by category color),
`überfällig` (past due, unmatched — destructive), `gebucht` (✓ matched,
muted). Chip click opens the plan's edit dialog. Bank chips (`•` gebucht,
`◌` nicht gebucht) are informational: matching and the forecast stay booked-
only — a pending row shows dashed/hollow but never checks a plan off, and
the reconcile later turns it into its booked version (then the match fires).

**Dashboard planned-vs-actual** (`app/page.tsx`): the "Geplant einblenden"
toggle fetches the forecast (12 months, honoring the account filter like
the balance) and merges it — the balance chart continues into a **dashed
projection line** (anchored at the last real point; suppressed when
imported future bookings already extend the series beyond today, which
would make the merged line run backwards), the cashflow chart stacks
**planned bars** (translucent; monthly planned sums exclude matched
occurrences so Ist + Geplant never double-count; planned expenses carry the
Ist outflow's negative sign so the `stackOffset: "sign"` stack places them
below the Ist expenses, planned income above the Ist income; the current
month stacks the real partial with the remaining plans, future months are
plan-only with the net line running through; with the toggle **off** the
Ist bars keep the pre-planning grouped layout, and segments with zero
planned money are omitted instead of rendering 0-value bars/tooltip rows),
and the categories chart stacks
planned expenses (translucent, per-category color) on top of the actual
bars. The toggle row shows the projected horizon balance. Content filters
(q/type/category/…) stay out of the money anchored on snapshots — same
rationale as the balance ([analytics.md](analytics.md)). A failed forecast
read under an active toggle surfaces the ErrorState + retry pattern
instead of reading as silently "no plans". The forecast hook serves no
cross-account placeholder data: switching the account filter blanks the
projection figures and chart overlay until the differently scoped read
lands, instead of briefly attributing the previous account's numbers to
the new account (the calendar's stale-while-loading visibility is
unaffected).

## Import lifecycle components

| Component                               | Role                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `components/drag-drop-provider.tsx`     | window-level drop overlay + upload                                                 |
| `components/active-import-provider.tsx` | tracks the newest batch, 1 s polling while non-terminal, completion fan-out        |
| `components/import-progress-pill.tsx`   | fixed bottom-center pill with stage + two progress bars, dismissible when terminal |
| `components/labeller-health-badge.tsx`  | header badge polling `/api/llm/health` every 30 s                                  |

## Header nav & session chip

`app/layout.tsx` composes the sticky header: left `AppNav` (desktop links,
`hidden sm:flex`), right group `LabellerHealthBadge` → `ThemeToggle` →
`HeaderUserChip` → `MobileNav`. The user chip
([components/user-chip.tsx](../components/user-chip.tsx)) shows name/email +
logout form on desktop (`hidden sm:flex`, icon-only below `md`); on mobile
(< sm) the hamburger sheet ([components/mobile-nav.tsx](../components/mobile-nav.tsx))
carries the user identity and a full-width "Abmelden" button in a footer
instead. Both `HeaderUserChip` and `MobileNav` call
[useSessionUser](../components/user-session.tsx) — the `/api/me` fetch is
deduplicated module-level (one request for all callers; logout is a full
page navigation, so no cache invalidation is needed). Logout is a plain
HTML form POST to `/auth/logout` (302 → provider end-session), guarded by
the CSRF check in [lib/auth/guard.ts](../lib/auth/guard.ts).

## Chart zoom

[hooks/use-chart-zoom.ts](../hooks/use-chart-zoom.ts) implements
pinch/wheel zoom + drag pan on the time-series charts: a non-passive wheel
listener (so `preventDefault` works), anchor-based scaling around the cursor,
drag-to-pan with bounds clamping, and a `resetKey` so a dataset/filter change
resets the window.

## Category colors

Every label gets a **permanent, unique** display color, stored in
`categories.color` (unique index; NULL only as legacy fallback). Colors are
allocated at creation inside the insert transaction
([lib/category-colors.ts](../lib/category-colors.ts)
`pickCategoryColor`): the first unused entry of the curated 12-color oklch
palette, then procedurally generated colors (golden-ratio hue walk, never
gray, picking the candidate farthest from all used colors). Existing DBs are
backfilled deterministically in `id ASC` order on startup. `null`
(unlabeled) is gray. The badge mixes the color via a CSS custom property +
`color-mix()` (`@utility category-badge` in `app/globals.css`). Rendering
falls back to a golden-ratio hash (`getCategoryColor`) only for legacy NULL
rows.

## Language

The UI is German-only (matching the DKB domain vocabulary — see the
[glossary](README.md#glossary)), while the **LLM label language** is
configurable via `LLM_LANGUAGE` (ISO 639-1, default `de`). No i18n framework
is used; strings are inline.
