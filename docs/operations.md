# Operations

_Last reviewed against v1.11.0 (rebrand: renamed compose project, `make oidc-teardown-legacy`, `LEGACY_OIDC_ISSUER_URL`)._

Running, configuring, and shipping the app. Setup basics live in the root
[README](../README.md); this guide covers what is behind the commands and
the operational decisions ([ADR-0012](adr/adr-0012-local-llama-server.md),
[ADR-0027](adr/adr-0027-docker-posture.md),
[ADR-0028](adr/adr-0028-shallow-healthcheck.md)).

## The Makefile

Developer entry points ([Makefile](../Makefile)); machine-specific overrides
belong in gitignored `Makefile.local` (included via `-include`), e.g. to opt
into Ollama's GPU-capable llama-server binary:

| Target                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make dev`                                 | Health-checks `:8080`, starts llama-server if needed, starts the dev OIDC provider if needed, installs deps, runs `bun dev` in the foreground; on exit a bash trap tears down what this invocation started — llama-server (pidfile via `llm-kill`, tracked via `/tmp/llama-server.managed`) and the OIDC containers (`docker compose down`, tracked via `/tmp/geldlage-oidc.managed`; the `authentik-db` named volume keeps the provisioned client). Pre-existing services are left running; stale markers from a crashed run are cleared whenever the service they reference is healthy at startup |
| `make app`                                 | Dev app only (llama-server + OIDC provider must already run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `make oidc`                                | Starts the throwaway Authentik stack ([compose.dev.yaml](../compose.dev.yaml), `:8081`) via Docker Compose, waits for first-boot migrations, then idempotently provisions the `geldlage` OIDC client ([scripts/dev-oidc-provision.ts](../scripts/dev-oidc-provision.ts)) and verifies OIDC discovery. Skipped when `:8081` is already ready                                                                                                                                                                                                                                                         |
| `make oidc-wait`                           | Polls `/-/health/ready/` up to 60 × 2 s (first boot runs DB migrations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `make oidc-down` / `oidc-stop`             | `docker compose down` (no `-v`): containers removed, the `authentik-db` named volume keeps the provisioned client; next `make oidc` re-creates from the current `compose.dev.env`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `make oidc-status` / `make oidc-logs`      | Health check / log tail for the dev provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `make oidc-teardown-legacy`                | One-time pre-rebrand cleanup: removes the old `dkb-analytics-dev-oidc` compose stack (no-op when absent, exits 0); runs automatically before `make oidc`. The orphaned `dkb-analytics-dev-oidc_authentik-db` volume is kept — `docker volume rm` by hand if you want it gone                                                                                                                                                                                                                                                                                                                        |
| `make model`                               | Downloads the pinned GGUF from Hugging Face: resumable (`curl -L -C -`), sanity-gated (≥ 1 GB + `GGUF` magic bytes), records the absolute path in `.llm-model`; accepts `MODEL=/path` or `HF_TOKEN` for gated repos                                                                                                                                                                                                                                                                                                                                                                                 |
| `make llm`                                 | Starts llama-server in the background: GPU auto-detection via `--list-devices` (CUDA/Vulkan/ROCm/SYCL → `-ngl auto --fit on`, else `-ngl 0` with a loud CPU warning), pid + log in `/tmp`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `make llm-wait`                            | Polls `/health` up to 120 × 2 s; detects a dead PID and dumps log tail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `make llm-kill`                            | Pidfile-targeted llama-server teardown with no health-check verdict — used by the `dev` trap and `stop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `make stop`                                | **Pidfile-targeted `kill -9` only** (`llm-kill`) — never touches llama-server processes this project didn't start; a failed health check reports leftovers without failing the target; also removes the dev OIDC provider containers (volume kept)                                                                                                                                                                                                                                                                                                                                                  |
| `make llm-stop`                            | llama-server-only teardown (`llm-kill` + leftover report) — same as `stop` **without** the OIDC step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `make llm-status`                          | Health + `nvidia-smi` GPU usage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `make check`                               | `typecheck` + `lint` + `format:check` (the CI trio)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `make test` / `build` / `start` / `format` | Vitest / Next build / Next start / Prettier                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Key llama-server flags and why:

- `-c $(LLM_CTX)` — context window (default 8192); must match the app's
  `LLM_CTX` env (the client-side budget guard reads the same variable).
- `--reasoning $(LLM_REASONING)` (default `off`) — thinking is disabled so
  the whole `max_tokens` budget goes to the JSON. Enable with
  `make llm LLM_REASONING=on` **and** set `LLM_REASONING=true` in the app:
  the thinking trace shares `max_tokens`, so the client must reserve
  `LLM_REASONING_BUDGET` thinking tokens or the JSON truncates
  deterministically. `--reasoning-budget` (server) caps the trace
  server-side and should match `LLM_REASONING_BUDGET`.
- `-fa on -ctk q8_0 -ctv q8_0` — flash attention with quantized KV cache;
  `-np 1` — single parallel slot (the app sends one batch at a time).
- `--no-webui` — API only.

The model is **pinned**: one exact GGUF file (`ggml-org/Qwen3.8-27B-GGUF`,
`Qwen3.8-27B-Q4_K_M.gguf`, ~19 GB) at a pinned Hugging Face revision. No
Ollama is involved anywhere — the app only requires an OpenAI-compatible
endpoint. Recipes use bash (`SHELL := /bin/bash`, `-o pipefail`); the
interactive download offer fails fast when stdin is not a TTY (CI/pipes).

## Configuration

All configuration is environment-based, read once via zod-validated
`getConfig()` ([lib/config.ts](../lib/config.ts)):

| Variable                 | Default                     | Purpose                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_PATH`          | `./data/geldlage.db`        | SQLite file (WAL sidecars alongside)                                                                                                                                                                                                           |
| `LLM_BASE_URL`           | `http://127.0.0.1:8080`     | llama-server base URL                                                                                                                                                                                                                          |
| `LLM_LANGUAGE`           | `de`                        | ISO 639-1 label language                                                                                                                                                                                                                       |
| `LLM_BATCH_SIZE`         | `20` (1–100)                | items per LLM request; > ~40 risks exceeding `LLM_CTX`                                                                                                                                                                                         |
| `LLM_MAX_RETRIES`        | `2`                         | transient-failure retries (timeouts never retry)                                                                                                                                                                                               |
| `LLM_TIMEOUT_MS`         | `300000`                    | per-request timeout                                                                                                                                                                                                                            |
| `LLM_CTX`                | `8192`                      | must match the server's `-c` flag (budget guard)                                                                                                                                                                                               |
| `LLM_MAX_ATTEMPTS`       | `5`                         | per-transaction labeling attempt cap                                                                                                                                                                                                           |
| `LLM_MAX_LABELS_PROMPT`  | `200` (0 disables)          | existing labels injected into prompts                                                                                                                                                                                                          |
| `LLM_REASONING`          | `false`                     | `true` when llama-server runs `--reasoning on`; the client then reserves thinking tokens in `max_tokens`                                                                                                                                       |
| `LLM_REASONING_BUDGET`   | `2048`                      | thinking tokens reserved per request when `LLM_REASONING=true`; keep in sync with the server's `--reasoning-budget` flag                                                                                                                       |
| `OIDC_ISSUER_URL`        | — (required)                | OIDC issuer (well-known discovery); any compliant provider. Dev default from `make oidc`: `http://localhost:8081/application/o/geldlage/` (plain-HTTP issuers opt into `allowInsecureRequests` automatically; HTTPS issuers are unaffected)    |
| `LEGACY_OIDC_ISSUER_URL` | — (optional)                | Pre-rebrand issuer URL (v1.10.x dev default `…/application/o/dkb-analytics/`); set only when upgrading so users still keyed on the old issuer are rewritten to `OIDC_ISSUER_URL` once at startup (lib/db, see CHANGELOG). Unset → no migration |
| `OIDC_CLIENT_ID`         | — (required)                | OIDC client id (dev: `geldlage`, provisioned by `make oidc`)                                                                                                                                                                                   |
| `OIDC_CLIENT_SECRET`     | — (required)                | OIDC client secret (confidential client; dev value in `.env`)                                                                                                                                                                                  |
| `OIDC_SCOPES`            | `openid profile email`      | scopes requested at the authorization endpoint                                                                                                                                                                                                 |
| `SESSION_TTL_SECONDS`    | `604800` (7 days)           | signed session cookie lifetime                                                                                                                                                                                                                 |
| `SESSION_SECRET`         | falls back to client secret | HS256 key for session cookies (min 32 chars)                                                                                                                                                                                                   |
| `APP_ORIGIN`             | derived from request        | public origin for redirects behind a reverse proxy                                                                                                                                                                                             |

See the root README for the full Docker Compose example (app + llama-server
on one network, named volume for `/app/data`).

## Docker image

The release workflow builds and pushes `ghcr.io/j-stechmann/geldlage:<release-tag>`
— one immutable tag per release, no `latest`, amd64
([ADR-0029](adr/adr-0029-git-flow-release.md)). Image anatomy
([Dockerfile](../Dockerfile)):

- **Multi-stage**, `node:24-bookworm-slim` in both stages (glibc is what
  better-sqlite3's NAPI prebuild needs; Node major is ABI-stable). Bun is
  copied in from the official image for the build only.
- `bun install --frozen-lockfile --ignore-scripts` — skips the implicit
  `node-gyp rebuild`; the prebuilt NAPI binary ships in the tarball, so no
  python/make/g++ toolchain is needed.
- **Fail-fast guard**: `RUN test -f .next/standalone/.../prebuilds/linux-x64.node`
  — a silent tracing regression fails the image build, not runtime.
- **Single write target**: only `/app/data` is created and chowned; the app
  runs as `USER node` (least privilege; the SQLite db + WAL are the only
  runtime writes).
- **Shallow healthcheck**: probes `/api/llm/health` — which always returns
  200 — so an external llama-server outage or a bad `DATABASE_PATH` never
  marks the container unhealthy ([ADR-0028](adr/adr-0028-shallow-healthcheck.md));
  schema setup in instrumentation logs failures instead of crashing startup.

## CI / release engineering

| Workflow                    | Trigger                                              | Does                                                                                                                             |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                    | every push, `workflow_dispatch`, **`workflow_call`** | lint → format check → typecheck → test → build (the reusable quality gate)                                                       |
| `release.yml`               | GitHub Release published                             | runs `ci.yml` as the `quality-assurance` job, then buildx → GHCR push with the exact release tag                                 |
| `dependabot-auto-merge.yml` | Dependabot PRs                                       | waits for CI (`gh pr checks --watch`), approves, `gh pr merge --auto`; **independently blocks major updates** (defense in depth) |
| `dependabot.yml`            | daily                                                | bun/docker/github-actions ecosystems, minor+patch only, grouped bun PRs, all targeting `develop`                                 |

Process rules (git-flow, Conventional Commits, release/hotfix flows) live in
[CONTRIBUTING.md](../CONTRIBUTING.md); decision rationale in
[ADR-0029](adr/adr-0029-git-flow-release.md) and
[ADR-0030](adr/adr-0030-dependabot-policy.md).

## Security & privacy posture

This is a **local-first, multi-user** app ([ADR-0032](adr/adr-0032-multi-user-oidc.md),
superseding the no-auth posture of [ADR-0031](adr/adr-0031-no-auth-local-first-privacy.md)):

- **TLS is mandatory for any non-localhost deployment.** The app must sit
  behind an HTTPS reverse proxy; set `APP_ORIGIN` to the public `https://`
  origin. Startup logs a loud warning when `APP_ORIGIN` is set and not
  HTTPS (an unset `APP_ORIGIN` means no public origin is declared and the
  check can't judge the transport): over plain HTTP, any same-network guest
  can read session cookies, OIDC tokens and all bank-data traffic, and can
  inject scripts into served pages. Add `Strict-Transport-Security` at the
  proxy.
- **Mandatory OIDC login** (PKCE + state + nonce, signed HttpOnly session
  cookie). `proxy.ts` gates everything except `/auth/*`, `/api/llm/health`
  (shallow healthcheck, [ADR-0028]) and static assets. Users are
  JIT-provisioned on first login keyed on `(issuer, subject)` — no allowlist;
  the provider is trusted to gate identities.
- **CSRF protection on every mutating route**: non-GET API handlers and
  `/auth/logout` validate `Origin`/`Sec-Fetch-Site` against the app origin
  (lib/auth/guard.ts `assertSameOrigin`), on top of the SameSite=Lax session
  cookie. `X-Forwarded-Host`/`X-Forwarded-Proto` are only trusted when
  `APP_ORIGIN` is set (proxy declaration — direct exposure must not honor
  client-settable forwarding headers).
- **Per-user data isolation**: every table row carries `user_id`; queries,
  import jobs and label-worker claims are user-scoped. Learned rules and
  labels are per user.
- The v1→v2 migration **drops pre-user tables** (fresh start for everyone —
  legacy single-user data is not attributed to any owner).
- Data locality remains ([ADR-0031](adr/adr-0031-no-auth-local-first-privacy.md)):
  all bank data stays local (SQLite in `data/`, model in `models/`, no
  telemetry). The only network egress is the model download from Hugging Face
  (`make model`), LLM calls to llama-server (127.0.0.1 in local dev), and the
  OIDC provider round-trips you configured.
- `.gitignore` and `.dockerignore` exclude `data/`, `*.db*`, `.env*`,
  `compose.dev.env`, `models/`, `.llm-model`, `Makefile.local` — bank data
  and machine state never leave the machine.
- **File permissions on multi-user hosts**: the SQLite database (WAL) and
  `.env` hold plaintext financial data and the session secret — keep them
  owner-only (`umask 077`, `chmod 600 data/* .env`; Docker deployments are
  already isolated by `USER node` + the chowned volume). A reminder is
  logged at startup.
- **Dev IdP hardening**: the Authentik stack binds `127.0.0.1` only and
  reads its credentials from the gitignored `compose.dev.env` (template:
  `compose.dev.env.example`; created on first `make oidc`). Never expose it
  beyond localhost — the app trusts the provider to gate identities.
- In Docker, llama-server must reach the app's compose network (the README
  example binds `0.0.0.0` _inside_ the compose network only); restrict port
  publishing if you adapt it.

## Backup / restore

Everything stateful is one directory: the SQLite database (WAL mode). Stop
the app (or checkpoint), then copy `data/` (all three files: `geldlage.db`,
`geldlage.db-shm`, `geldlage.db-wal`) or the named Docker volume. Restoring is copying
them back — the schema is auto-created/migrated on next boot.

## Troubleshooting

| Symptom                                               | Likely cause / fix                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login fails with 502 `login_failed`                   | Dev provider down — `make oidc` / `make oidc-status`; check `make oidc-logs` if it never becomes ready                                                                                                                                     |
| Authorize redirects back with `error=invalid_request` | The dev provider's registered redirect URIs don't cover the app's origin/port (e.g. Next picked 3001) — `make oidc` reconciles the provider from `.env` on every run; a manual re-run of `bun scripts/dev-oidc-provision.ts` does the same |
| Warning about prompt+completion exceeding context     | `LLM_BATCH_SIZE` too high for `LLM_CTX` — lower the batch or raise `LLM_CTX` **on both sides** (server flag + app env)                                                                                                                     |
| Labels stay "wird kategorisiert" forever              | llama-server down or unhealthy — check the header badge / `make llm-status`; the health gate is pausing the worker                                                                                                                         |
| Rows "ohne Kategorie"                                 | Attempts exhausted — use the retry button (fresh budget); no fallback labels are ever invented                                                                                                                                             |
| Batches `failed` after a crash                        | Startup recovery marked interrupted batches failed; re-import the CSV (dedupe makes this safe)                                                                                                                                             |
| CPU-only warning from `make llm`                      | GPU build not detected; install CUDA/Vulkan llama.cpp packages or use `Makefile.local` with Ollama's binary                                                                                                                                |
