# ADR-0012: Local llama.cpp llama-server via OpenAI-compatible API (no Ollama, no cloud)

_Status: accepted · Date: 2026-09 (v1.5.0 labeller)_

## Context

Transaction labeling needs an LLM. Constraints: bank data must never leave
the machine, labeling must be cheap to run continuously, and the app should
be self-contained (no paid API, no account).

## Decision

Talk **OpenAI-compatible chat completions** to a local llama.cpp
`llama-server` (`LLM_BASE_URL`, default `127.0.0.1:8080`) running one pinned
GGUF model (downloaded at a pinned Hugging Face revision by `make model`).
**No Ollama is involved anywhere** — the Makefile is explicit about this and
only reuses Ollama's _binary_ when a user opts in via `Makefile.local`.
Server flags are standardized (`--reasoning` configurable via
`LLM_REASONING`, default `on`, `on`/`off` — `true`/`false` accepted and
normalized; both sides must agree on on/off because the trace shares the
request's token budget and the client must reserve for it
(`LLM_REASONING=true`); `auto` would let the model decide per request,
which the client cannot reserve for. The thinking cap is enforced per
request: the client pins llama.cpp's `reasoning_budget_tokens` to its
`LLM_REASONING_BUDGET`, so the server's `--reasoning-budget` flag is only
a fallback cap for non-app traffic, not a sync requirement;
`-fa on -ctk q8_0 -ctv q8_0`; `-c` must
match the app's `LLM_CTX`).

GPU support is auto-detected at runtime (`--list-devices`), falling back to
CPU with a loud warning.

## Alternatives considered

- **Cloud LLM (OpenAI/Anthropic)** — best quality, but sends bank data to
  third parties and costs per call; unacceptable here.
- **Ollama as the runtime** — convenient, but pins its own model management
  and versioning; llama-server's flags give the control the labeller needs
  (grammar-constrained decoding, explicit reasoning on/off).
- **Local transformer via JS (transformers.js)** — slower, weaker models for
  this task.

## Consequences

- Positive: privacy (all egress is the one-time model download), zero marginal
  cost, full determinism control (`temperature: 0`), no rate limits.
- Negative: needs ~19 GB of disk and a decent machine (CPU-only is slow);
  the app must handle unavailability gracefully — hence the health gate and
  no-fallback-labels policy.
