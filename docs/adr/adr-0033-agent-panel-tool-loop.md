# ADR-0033: Agent chat panel with native tool calling over the shared llama-server

_Status: Accepted · Date: 2026-10-06_

## Context

The app talks to one local llama.cpp `llama-server` ([ADR-0012]) that, until
now, served exactly one purpose: grammar-constrained labeling of transactions
([ADR-0016]). A second consumer appeared without a second server: an
app-wide agent panel ("KI-Chat") where the user asks questions about their
finance data in natural language and gets answers grounded in the database —
which means **tool calling**, a new surface in a codebase whose LLM path had
exactly one request shape.

The server is a constraint the design must accept. llama-server runs with
`-np 1` (one processing slot): the agent's rounds share that slot with label
batches, and requests queue behind each other. The model is Qwen3 behind the
OpenAI-compatible API — llama-server supports the **native tools API** there
(`tools`/`tool_choice` request fields, `message.tool_calls` and
`delta.tool_calls` in the response), so a prompt-side JSON protocol for tool
requests would be solving a problem the server already solved, while
sacrificing server-side tool-call parsing and the reasoning trace handling
that comes with it.

Two multi-user realities from [ADR-0032] shape the rest: every route runs
with a session user, and data is per-user. A chat thread worth having is
worth sharing, so threads need members and invites — and whatever tools the
agent runs must never leak another member's transactions.

## Decision

The agent chat is built from six pieces:

- **Shared SSE plumbing** (lib/llm/sse.ts): frame parsing was already
  implemented inside lib/llm/client.ts for the label path; the generator is
  extracted into lib/llm/sse.ts and used by both consumers. The label path
  folds frames through `collectSse` + its own loop, the agent path iterates
  `sseGenerator` directly (it needs tool-call deltas). Frame semantics —
  multi-line `data:` joined with `\n`, `[DONE]` dropped, blank-line
  separators in every permutation (LF/CRLF/CR), final frame without
  trailing blank line still valid — are unchanged and covered by the
  existing llm-client tests.

- **Native tools API, registry-driven** (lib/agent/tool-registry.ts, lib/agent/tools/*): no
  prompt-side JSON protocol and no grammar — tool calls are requested with
  `tools` + `tool_choice: "auto"` and executed from the model's
  `tool_calls`. Tools live in one ordered registry array
  (`tool-registry.ts`); adding a tool is one entry (name, description,
  JSON-schema parameters, `execute`) in its own module under
  lib/agent/tools/ — the wire `tools` array (`toolsForRequest()`) and the
  system prompt's tool list derive from it. The registry holds exactly one
  tool, `get_category_totals`
  (period `this_month | last_month | last_90_days`, ISO-date string
  comparison against `booking_date` — exact calendar math, no timezone
  drift). **All tools are read-only** and every tool executes with the
  **speaker's uid** (`ctx.uid`) — in a shared thread the answers reflect
  whoever asked, never another member's data; the system prompt states this
  explicitly so participants are not misled. Execution with full error
  absorption (unknown tool, unparseable args, thrown errors → JSON
  `{"error": …}` results) lives in lib/agent/tool-executor.ts, separate
  from the loop's round state machine.

- **Round semantics** (lib/agent/loop.ts, AGENT_MAX_TURNS = 5): the loop
  drives `stream_agent_chat` until the model answers without tool calls, with
  a hard turn budget. The final allowed round is called **without the
  `tools` field** (stripping the field, not `tool_choice: "none"` — some
  llama-server builds reject `tools: []`, so an empty registry means the
  field is omitted entirely) to force a real answer; any tool calls that slip
  out anyway are ignored. An empty answer on a tools-allowed round gets
  **exactly one tools-free retry**, then the turn ends regardless — a silent
  exit beats a hang. Tool misbehavior never throws inside the loop:
  unknown tools, unparseable args and thrown tool errors all become JSON
  `{"error": …}` tool results, so the model sees the problem and can
  self-correct; only stream/infrastructure errors propagate.

- **SSE to the browser, persistence-free loop** (app/api/agent/…/chat,
  lib/agent/sse-writer.ts, lib/agent/turn-persister.ts): the loop yields
  events and knows nothing about the database; the **route** streams them
  as named SSE events — `delta` (content), `reasoning`, `tool_call`,
  `tool_result`, `done`, `error` — and does all persistence: the user
  message immediately, one tool row per `tool_result` (with its preceding
  `tool_call` args), and the final assistant row (content + reasoning) at
  `done`. The route is protocol wiring only: frame encoding, headers and
  the error→frame mapping live in sse-writer.ts; the write-side state
  machine (tool_call→tool_result args pairing, assistant row, thread
  touch) lives in turn-persister.ts. All agent routes gate through one
  shared guard (lib/agent/route-guard.ts: session → CSRF → roleOf → 404)
  instead of seven copies of the same boilerplate. Persisting per
  tool_result keeps `threadSeq` order identical to the streamed event
  order. Client disconnects (`request.signal`) are forwarded into the loop
  so the in-flight LLM fetch aborts instead of burning tokens for nobody;
  infrastructure failures stream one `error` frame then close.

- **Reasoning is display metadata** (lib/agent/chat-client.ts): llama-server's
  `reasoning_content` streams through as its own event, is shown in the panel
  (collapsible "Denkprozess") and persisted on the assistant row, but is
  **never replayed** into later rounds' history — the request builder drops
  it, because thinking tokens belong to the round that produced them and
  replaying them would bloat the prompt with stale traces. The request pins
  `temperature: 0.3` (a chat persona needs some freedom; labeling keeps 0)
  and `max_tokens = reasoning budget + 2048` (same token accounting as the
  label path: the thought shares the completion budget). History is windowed
  per request (lib/agent/window.ts): last 24 messages anchored at the newest
  user message (slicing may not start mid-protocol — llama-server rejects
  orphan tool continuations), fields truncated at 4000 chars with "…", and a
  chars/4 estimate warns once per turn when the prompt exceeds 90% of
  `LLM_CTX`.

- **Threads with invite-based sharing** (lib/agent/store.ts + lib/agent/store/*,
  chat_tables): `chat_threads` (owner = creator), `chat_thread_members`
  (roles via `roleOf()`: `owner | member | invited`, state `invited →
joined`) and `chat_messages` (roles `user | assistant | tool`, CHECK
  enforced in the hand-written DDL). store.ts is a barrel over the split
  concern modules (store/threads.ts, store/members.ts, store/messages.ts,
  store/thread-access.ts). Invites are idempotent (conflict-
  nothing on the `(thread_id, user_id)` primary key, owner un-invitable);
  **`GET /api/users`** serves the invite dialog the full user directory — a
  deliberate PII exposure on a local, single-instance app where every
  provisioned identity sits inside the same trust boundary (the OIDC
  provider already gates who gets a workspace at all); per-row redaction
  would buy nothing. Titles auto-fill after the first turn (AI titling,
  below). Messages carry
  a per-thread `seq` counter (advanced in the same transaction as the
  insert) for stable ordering; thread deletion cascades members and messages
  (`ON DELETE CASCADE`).

- **AI thread titling** (lib/agent/thread-title.ts): while a thread wears
  the default title ("Neuer Chat", defined once in
  lib/agent/constants.ts — schema drizzle default + hand-written DDL + the
  create route all read it), the chat route fires a fire-and-forget
  one-shot completion after the turn's `done` (tools-free; the single
  llama-server slot is free then). The sanitized answer (quotes stripped,
  80-char cap, placeholder answers rejected) replaces the default; an
  unusable answer or LLM failure falls back to the first 24 chars of the
  first user message. The default-title guard runs at call time AND on
  write, so a user rename during the turn can never be clobbered.

**Access rule matrix** — every agent route gates on `roleOf` first:

| Caller          | Read/participate              | Invite/rename/delete | DELETE semantics          |
| --------------- | ----------------------------- | -------------------- | ------------------------- |
| `owner`         | full                          | full                 | deletes thread (cascades) |
| joined `member` | full                          | none                 | leaves (thread survives)  |
| `invited`       | title only (join panel in UI) | none                 | declines (row removed)    |
| unknown/foreign | —                             | —                    | **404**, never 403        |

The 404-not-403 rule is deliberate: a `403` would confirm to an
authenticated outsider that the id belongs to someone else's thread
(existence disclosure), while a `404` is indistinguishable from a random id
— the same posture as the auth gate returning 404-shaped responses rather
than role hints.

**UI composition** (components/agent/*): the panel is a **docked,
pointer-resizable right column** on md+ (280–720 px, open + width persisted
to `localStorage`) and a full-screen overlay below md. Its open/width state
is a module-level `useSyncExternalStore` store (panel-state.ts) shared by
the header toggle and the dock without a provider. `app/layout.tsx` composes it
into the main `flex` row — `AppNav`, pages and their layouts remain
untouched. Sidebar groups: Meine Chats / Geteilte Chats / Einladungen.
The 1,000+-line chat monolith is split by responsibility: `agent-api.ts`
(typed fetchers + React Query keys + a typed `ApiError` — the invited-
preview 404 surfaces as a query error, never as fake success data),
`sse-events.ts` (client dispatch of the named frames over the SHARED
`lib/llm/sse.ts` generator — one SSE parser server- and client-side),
`use-agent-threads.ts` (queries, active-thread derivation with
localStorage persistence), `use-agent-turn.ts` (the streaming turn state
machine: optimistic user message, abort, post-done refetch), and one file
per UI part (thread-bar, message-list, assistant-bubble, tool-chip,
chat-input, invite-dialog) — `agent-chat.tsx` is a ~200-line orchestrator.
DOM tests (jsdom + testing-library) cover the lifecycle end to end
(tests/agent-panel-ui.test.tsx).

**Concurrency**: llama-server keeps `-np 1` — agent turns share the single
slot with label batches, and either queues behind the other. Acceptable for a
local tool with human-paced turns; revisit with `--parallel`/`-np N` if
round-trip latency degrades under concurrent label jobs.

## Alternatives considered

- **Prompt-side tool protocol (JSON instructions) + grammar** — works with
  any backend, but re-implements what llama-server's native tools API
  already does (call parsing, arg JSON assembly by index), couples the tool
  format to our own prompt constants, and forfeits `tool_choice` steering.
- **Write tools in v1** — rejected until a mutation boundary is designed
  (which rows may the model change, under which confirmation): an agent that
  can silently relabel or delete user data is a liability, not a feature.
- **A second llama-server slot from the start (`-np 2+`)** — doubles KV
  memory for a traffic pattern (few humans asking questions) that does not
  need it; queueing at `-np 1` is observable and recoverable.
- **Push instead of polling for other users' messages** — a real pub/sub
  channel (SSE fan-out or long-poll) was deferred; member views poll at 4 s
  (messages) / 15 s (threads) instead, acceptable locally.

## Consequences

- Positive: one model, one server, two consumers with shared SSE/error
  plumbing; tool extension without prompt-template surgery; per-user data
  isolation holds even in shared threads; the loop stays testable in
  isolation (pure event stream, no DB).
- Negative: +3 tables and 8 new route files; `GET /api/users` exposes
  every user's name/email to any authenticated user (documented PII
  tradeoff); no write tools until a mutation boundary exists; agent turns
  queue behind (or before) label batches on the single slot; shared-thread
  freshness relies on polling rather than push.
- Neutral: reasoning tokens are paid once per round (budget reserved in
  `max_tokens`) but stored only where they were shown.

[ADR-0012]: adr-0012-local-llama-server.md
[ADR-0016]: adr-0016-grammar-constrained-decoding.md
[ADR-0032]: adr-0032-multi-user-oidc.md
