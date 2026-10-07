# Frontend

_Last reviewed against v1.14.0 (transactions tab with URL-synced filters)._

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
next to `<main>` in the main content row, so pages and `AppNav` stay
untouched.

| Component / module                      | Role                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/agent/agent-toggle.tsx`     | Header icon button (`aria-pressed`), toggles the dock via the shared panel store                                                                                                                      |
| `components/agent/agent-dock.tsx`       | Dock frame: resizable right column on md+ (`ResizeHandle` with pointer capture), full-screen overlay with close button below md                                                                       |
| `components/agent/agent-chat.tsx`       | Slim orchestrator (~200 lines): composes the four UI parts around the two hooks; owns the mutation handlers with their German toasts                                                                  |
| `components/agent/thread-bar.tsx`       | Thread bar: new-chat, inline rename, owner actions (rename/invite/delete), member leave, grouped dropdown (Meine Chats / Geteilte Chats / Einladungen, `ThreadSelect`/`ThreadGroup`)                  |
| `components/agent/message-list.tsx`     | Message list: persisted rows (`MessageRow`, `UserBubble`), optimistic pending user message, streaming bubble, pin-to-bottom, invited join panel + empty state                                         |
| `components/agent/assistant-bubble.tsx` | The ONE assistant bubble: reasoning toggle ("Denkprozess"), tool chips, streamed/persisted content — `streaming` only toggles defaults (thinking open, cursor)                                        |
| `components/agent/tool-chip.tsx`        | Tool round chip (name + expandable JSON args/result), shared by persisted rows and the streaming bubble                                                                                               |
| `components/agent/chat-input.tsx`       | Composer: Enter sends (Shift+Enter / IME excluded), send button swaps to stop while streaming                                                                                                         |
| `components/agent/invite-dialog.tsx`    | Invite dialog: user directory fetched only while open minus existing members, checkbox multi-select                                                                                                   |
| `components/agent/use-agent-threads.ts` | Threads/detail React Query hooks (polling 15 s / 4 s paused while streaming), active-thread derivation with `localStorage` persistence (`geldlage.agent.thread`), lazy thread creation                |
| `components/agent/use-agent-turn.ts`    | Streaming turn state machine: optimistic user message, SSE consumption into stream state, abort handling, post-done invalidation of messages+threads                                                  |
| `components/agent/agent-api.ts`         | Typed fetchers for all agent endpoints, React Query keys (`THREADS_KEY`/`MESSAGES_KEY`/`USERS_KEY`), `ApiError` on non-OK JSON (a 404 for invited preview surfaces as a query error, not fake data)   |
| `components/agent/sse-events.ts`        | Client-side dispatch of the named SSE frames, built on the SHARED parser `lib/llm/sse.ts` (`sseGenerator`) — the same generator the server-side loop client consumes                                  |
| `components/agent/types.ts`             | Client-side DTOs mirroring the server contract (single source, no inline copies)                                                                                                                      |
| `components/agent/panel-state.ts`       | Module-level `useSyncExternalStore` store: `{open, width}`, persisted to `localStorage` (`geldlage.agent.open`/`.width`); SSR serves closed, lazy first-client hydrate (no provider, no layout flash) |

**Dock behavior**: on md+ the panel is a sticky flex column pinned under the
header (`top-14`, `h-[calc(100svh-3.5rem)]`) whose width the user drags
between 280 and 720 px (clamped, persisted); below md it renders as a fixed
full-screen overlay. The chat is streamed over SSE
(`delta`/`reasoning`/`tool_call`/`tool_result`/`done`/`error` frames):
content renders incrementally into a streaming bubble, the model's thinking
trace appears as a collapsible **Denkprozess** (open while streaming,
collapsed on the persisted row), and each tool round renders as a **tool
chip** (name + expandable JSON args/result).

**Threads and invites**: the thread bar dropdown groups Meine Chats /
Geteilte Chats / Einladungen; selecting an invite shows the join panel
(Annehmen/Ablehnen) instead of messages — content unlocks exactly on join
(the API 404s for invited users, and `agent-api.ts` turns that 404 into a
query error so the join panel renders). Owners get rename, invite (the
`InviteDialog` fetches the user directory from `GET /api/users`, filtering
out existing members) and delete; joined members get leave; invited users
decline. Sending the first message can auto-create a thread; the active
thread id persists in `localStorage`.

**React Query keys** (same conventions as above):

| Query key                      | Fetches                            | Polling                                          |
| ------------------------------ | ---------------------------------- | ------------------------------------------------ |
| `["agent-threads"]`            | `/api/agent/threads`               | 15 s                                             |
| `["agent-messages", threadId]` | `/api/agent/threads/[id]/messages` | 4 s, **paused while streaming** (`retry: false`) |
| `["agent-users"]`              | `/api/users`                       | — (only while the invite dialog is open)         |

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
Status, Label-Status) → KPI row → four charts. No transactions table — it
lives on its own tab. Flow aggregates (cashflow, categories, transaction
count) react to every filter including Status; balance and savings are
time-scoped by design: snapshots anchor an absolute booked account balance,
so content filters (q/type/category/labelStatus/**status**) are ignored
([lib/analytics/engine.ts](../lib/analytics/engine.ts),
`buildTimeScopedWhere`).

### `/transactions`

The full transaction table: **all schema fields as columns** (Buchung,
Wertstellung, Status, Vertragspartner, Verwendungszweck, IBAN, Typ, Konto,
Kategorie, Label-Status, Gläubiger-ID, Mandatsreferenz, Kundenreferenz,
Betrag) with a persisted column-visibility toggle (Spalten dropdown,
`localStorage`). Hand-rolled on shadcn `Table` primitives with server-side
everything: pagination (fixed 25 rows), sorting (booking date, value date,
status, payee, amount), and filtering all happen in SQL; the client only
serializes state into the query string
([ADR-0026](adr/adr-0026-server-side-table.md)).

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
