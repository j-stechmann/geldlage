# Changelog

## Unreleased

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
