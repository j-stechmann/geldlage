# ADR-0016: Grammar-constrained decoding, context budget guard, Rust-ported retry taxonomy

_Status: accepted · Date: 2026-09 (v1.5.0 labeller)_

## Context

The labeller asks an LLM to return strict JSON for a batch of transactions.
Failure modes observed with llama-server: prose around JSON, silent output
clamping at the context window (which truncates JSON mid-array), and
non-deterministic retry behavior at `temperature 0`.

## Decision

Three coordinated mechanisms in [lib/llm/client.ts](../../lib/llm/client.ts) /
[prompt.ts](../../lib/llm/prompt.ts):

1. **Grammar-constrained decoding**: `response_format: { type:
"json_schema" }` with a schema bounding the array to exactly `itemCount`
   items and the echoed `index` to `[0, itemCount-1]` — the grammar itself
   cannot produce out-of-range indices.
2. **Client-side context budget guard**: llama-server clamps output silently
   at its context window; the client estimates tokens (`chars/4`) and warns
   once per request when `promptTokens + max_tokens > LLM_CTX`. Exceeding
   the context stays an operator error surfaced by this warning (clamping
   `max_tokens` locally would truncate deterministically anyway).
   `max_tokens = max(1024, items.length * 96)` plus
   `LLM_REASONING_BUDGET` when `LLM_REASONING=true` (the thinking trace
   shares the completion budget when llama-server runs `--reasoning on`).
3. **Retry taxonomy** (ported from a Rust client): timeouts are **never**
   retried (including mid-body-read aborts); network errors, 429/5xx, and
   malformed payloads are retried with backoff `200ms · 4^(attempt-1) +
jitter [0, base/4]`, capped by `LLM_MAX_RETRIES`; other HTTP statuses fail
   immediately. `return await` discipline keeps rejections inside the retry
   loop.

Response association is index-aware (echoed index pins the slot; missing
indices fill the next open slot; out-of-range dropped, not shifted; unfilled
slots are omitted — the caller marks them failed).

## Alternatives considered

- **Prompt-only JSON instructions + hope** — prose poisoning observed in
  practice; `extractJson()` (balanced-brace scan) remains as the second line
  of defense.
- **Server-side token accounting** — llama-server doesn't report it per
  request; client-side estimation with the shared `LLM_CTX` env is the
  pragmatic guard.

## Consequences

- Positive: structurally valid batches by construction; truncation is a loud
  operator error instead of a silent attempt-burner; deterministic retry
  behavior.
- Negative: relies on llama-server honoring `json_schema` (it does; the
  client still sanitizes); the token estimate is approximate (chars/4) —
  hence "warning", not enforcement.
