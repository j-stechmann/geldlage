import { getConfig } from "@/lib/config"
import { collectSse, isTimeoutError, safeBody } from "@/lib/llm/sse"
import {
  neutralizeMarkers,
  responseSchema,
  systemPrompt,
  truncateField,
  userPrompt,
  type PromptTransaction,
} from "@/lib/llm/prompt"

export type LlmHealth = "ok" | "degraded" | "unreachable"

/** One result per input transaction, in input order. */
export interface LabelResult {
  id: string
  label: string
}

/** Error classification mirroring the ported Rust retry semantics. */
export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM request timed out after ${ms}ms`)
    this.name = "LlmTimeoutError"
  }
}

export class LlmUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmUnreachableError"
  }
}

export class LlmHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string
  ) {
    super(`LLM HTTP ${status}: ${body.slice(0, 500)}`)
    this.name = "LlmHttpError"
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

interface ChatBody {
  messages: Array<{ role: string; content: string }>
  temperature: number
  max_tokens: number
  response_format: {
    type: "json_schema"
    json_schema: { schema: Record<string, unknown> }
  }
  /** llama.cpp extension: pins the server's per-request thinking cap. */
  reasoning_budget_tokens?: number
  /**
   * Streaming keeps undici's fixed 300 s headersTimeout from firing while
   * the server computes the batch: with `stream: true` llama-server flushes
   * SSE headers immediately and emits a delta per token, so both of
   * undici's timers (headersTimeout / bodyTimeout) reset chunk by chunk.
   * LLM_TIMEOUT_MS via AbortSignal.timeout is the deadline while deltas
   * keep arriving — a stream that stalls for >300 s instead fails
   * bodyTimeout (UND_ERR_BODY_TIMEOUT), which retries as transient.
   */
  stream: true
}

export class LlmClient {
  constructor(private readonly baseUrl?: string) {}

  private get cfg(): ReturnType<typeof getConfig> {
    return getConfig()
  }

  private get root(): string {
    return (this.baseUrl ?? this.cfg.LLM_BASE_URL).replace(/\/+$/, "")
  }

  /** Cheap reachability probe used as the worker's health gate. */
  async health(): Promise<LlmHealth> {
    try {
      const res = await fetch(`${this.root}/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) return "ok"
      return "degraded"
    } catch {
      return "unreachable"
    }
  }

  /**
   * Label one batch against llama-server. Returns one result per successfully
   * labelled item: model-echoed indices inside [0, items.length) are honored
   * (first valid label per slot wins), entries without a usable index fill
   * the next open slot, unfilled slots are omitted — the caller decides
   * (mark failed), keeping "no fallback labels". Transient failures
   * (network, 429, 5xx) are retried with exponential backoff; a timeout is
   * NOT retried — it throws LlmTimeoutError so the caller marks claimed rows
   * failed (there are no fallback labels).
   *
   * The SSE plumbing (readSse/collect/timeout classification) moved to
   * lib/llm/sse.ts in ADR-0033 — shared verbatim with the agent chat path.
   */
  async labelBatch(
    items: PromptTransaction[],
    existingLabels: string[] = []
  ): Promise<LabelResult[]> {
    if (items.length === 0) return []

    const cfg = this.cfg
    const body: ChatBody = {
      messages: [
        {
          role: "system",
          content: systemPrompt(cfg.LLM_LANGUAGE, existingLabels),
        },
        { role: "user", content: userPrompt(items) },
      ],
      temperature: 0,
      // 96 tokens/item: labels cap at 64 UTF-8 bytes (sanitizeLabel) plus
      // index overhead — the old 24/item truncated large batches mid-JSON,
      // and at temperature 0 a deterministic truncation burns every attempt.
      // When the server runs with `--reasoning on`, the thinking phase
      // shares this budget: the reserved tokens must be added or the trace
      // alone fills max_tokens and the JSON truncates deterministically.
      max_tokens:
        (cfg.LLM_REASONING ? cfg.LLM_REASONING_BUDGET : 0) +
        Math.max(1024, items.length * 96),
      // Enforcement of the reserve: pin the server's per-request thinking
      // cap (llama.cpp's `reasoning_budget_tokens`, which overrides the
      // `--reasoning-budget` server flag) to exactly the budget reserved
      // above — the trace can then never outgrow max_tokens' reserve, no
      // matter what flags an already-running server or Docker container
      // was started with. A backend without thinking support (or with
      // reasoning off) ignores it; it is only sent when reasoning is on.
      ...(cfg.LLM_REASONING && {
        reasoning_budget_tokens: cfg.LLM_REASONING_BUDGET,
      }),
      response_format: {
        type: "json_schema",
        json_schema: { schema: responseSchema(items.length) },
      },
      stream: true,
    }

    // guard: prompt + completion must fit the server context (LLM_CTX, the
    // `-c` flag llama-server runs with). Exceeding it gets the output
    // clamped silently and the truncated JSON burns every attempt at
    // temperature 0. Clamping max_tokens here would truncate deterministically
    // anyway, so exceeding ctx stays an operator error surfaced by this
    // warning (chars/4 is a rough token estimate). With reasoning enabled
    // the reserved thinking tokens are part of max_tokens (see above).
    const promptTokens = Math.ceil(
      (body.messages[0].content.length + body.messages[1].content.length) / 4
    )
    if (body.max_tokens + promptTokens > cfg.LLM_CTX) {
      console.warn(
        `[llm] completion budget (${body.max_tokens}) + estimated prompt ` +
          `(${promptTokens}) exceeds LLM_CTX (${cfg.LLM_CTX}) — output will be ` +
          `clamped and the JSON may truncate, burning all attempts. Lower ` +
          `LLM_BATCH_SIZE or raise LLM_CTX on both sides (make llm ` +
          `LLM_CTX=… for the server; the app reads the same env var and ` +
          `must be restarted with it).`
      )
    }

    let retriesLeft = cfg.LLM_MAX_RETRIES
    let attempt = 0
    for (;;) {
      let res: Response
      try {
        res = await this.chat(body)
      } catch (err) {
        // AbortSignal.timeout() rejects fetch with a DOMException named
        // "TimeoutError" — timeouts are NOT retried (no fallback labels:
        // the caller marks the claimed rows failed)
        if (isTimeoutError(err)) {
          throw new LlmTimeoutError(this.cfg.LLM_TIMEOUT_MS)
        }
        if (err instanceof LlmTimeoutError) throw err
        // network error behaves like backend down (transient)
        if (retriesLeft > 0) {
          retriesLeft--
          attempt++
          await sleep(backoffMs(attempt))
          continue
        }
        throw new LlmUnreachableError((err as Error).message)
      }

      if (res.ok) {
        // Malformed payloads (missing content, unparseable JSON, missing
        // results array) are transient like 5xx: retry with backoff instead
        // of failing the batch on the first bad response. At the retry cap
        // the error propagates and the caller marks the rows failed (no
        // fallback labels). A timeout while reading the body is NOT retried
        // (same DOMException TimeoutError as the fetch itself — see
        // isTimeoutError).
        try {
          // `return await` is required: a bare `return promise` would let a
          // rejection escape the try block and skip the retry below
          return await this.parseChatResponse(res, items)
        } catch (err) {
          if (isTimeoutError(err)) {
            throw new LlmTimeoutError(this.cfg.LLM_TIMEOUT_MS)
          }
          if (retriesLeft > 0) {
            retriesLeft--
            attempt++
            await sleep(backoffMs(attempt))
            continue
          }
          throw err
        }
      }

      if (res.status === 429 || res.status >= 500) {
        if (retriesLeft > 0) {
          retriesLeft--
          attempt++
          await sleep(backoffMs(attempt))
          continue
        }
        throw new LlmHttpError(res.status, await safeBody(res))
      }

      throw new LlmHttpError(res.status, await safeBody(res))
    }
  }

  private async chat(body: ChatBody): Promise<Response> {
    return fetch(`${this.root}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.LLM_TIMEOUT_MS),
    })
  }

  /**
   * Index-aware association: a model-echoed `index` within
   * [0, items.length) pins the label to that item; entries without an
   * integer index fill the next open slot; out-of-range indices are dropped
   * (not shifted). First valid label per
   * slot wins, duplicate/empty labels skipped, extra results dropped.
   * Unfilled slots are absent from the output — the caller decides (mark
   * failed), keeping "no fallback labels".
   */
  private async parseChatResponse(
    res: Response,
    items: PromptTransaction[]
  ): Promise<LabelResult[]> {
    // A body read aborted by AbortSignal.timeout rejects with the same
    // TimeoutError DOMException as fetch itself — rethrown so labelBatch
    // classifies it as a timeout instead of a malformed "transient" body.
    // (A stream that stalls >300 s instead rejects via undici's
    // bodyTimeout, which stays transient — see the `stream: true` note.)
    const content = await readContent(res)
    if (typeof content !== "string") {
      throw new LlmHttpError(res.status, "response missing message content")
    }
    const parsed = extractJson(content)
    if (!parsed) {
      throw new LlmHttpError(res.status, "no valid JSON object in response")
    }
    const results = parsed.results
    if (!Array.isArray(results)) {
      throw new LlmHttpError(res.status, "missing results array")
    }

    const out: (LabelResult | null)[] = new Array(items.length).fill(null)
    let fallbackSlot = 0
    for (const entry of results) {
      if (!entry || typeof entry !== "object") continue
      const label = (entry as { label?: unknown }).label
      if (typeof label !== "string") continue
      const cleaned = sanitizeLabel(label)
      if (!cleaned) continue
      const index = (entry as { index?: unknown }).index
      let slot = -1
      if (typeof index === "number" && Number.isInteger(index)) {
        if (index < 0 || index >= items.length) continue
        slot = index
      } else {
        while (fallbackSlot < items.length && out[fallbackSlot] !== null) {
          fallbackSlot++
        }
        if (fallbackSlot >= items.length) break
        slot = fallbackSlot
      }
      if (out[slot] !== null) continue
      out[slot] = { id: items[slot].id, label: cleaned }
    }
    return out.filter((r): r is LabelResult => r !== null)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 200ms · 4^(attempt-1) + jitter [0, base/4] — ported from the Rust client. */
function backoffMs(attempt: number): number {
  const base = 200 * 4 ** (attempt - 1)
  return base + Math.random() * (base / 4)
}

/**
 * Reads the assistant content out of a chat-completions response.
 * `text/event-stream` (the requested `stream: true` mode): accumulates
 * `choices[0].delta.content` fragments across SSE frames. Anything else
 * (a proxy or backend that ignored `stream`, or a plain JSON error-shaped
 * body with status 200): falls back to the non-streaming message shape.
 * Reading errors surface unchanged — a TimeoutError DOMException from the
 * aborted body keeps its classification (see labelBatch).
 */
async function readContent(res: Response): Promise<string | null> {
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    const payload = (await res.json().catch((err) => {
      if (isTimeoutError(err)) throw err
      return null
    })) as {
      choices?: Array<{ message?: { content?: string } }>
    } | null
    return payload?.choices?.[0]?.message?.content ?? null
  }

  const sse = await collectSse(res)
  let content: string | null = null
  for (const frame of sse) {
    const payload = JSON.parse(frame) as {
      choices?: Array<{ delta?: { content?: unknown } }>
    }
    // delta.content only: `reasoning_content` is deliberately ignored, just
    // as the non-streaming path reads only message.content — the thinking
    // trace must never reach extractJson.
    const fragment = payload.choices?.[0]?.delta?.content
    if (typeof fragment !== "string") continue
    content = (content ?? "") + fragment
  }
  return content
}

/**
 * Extracts a JSON object from model output: successive `{` candidates,
 * balanced-brace scan respecting string escapes, first full parse wins.
 * Ported from the Rust `extract_json`/`balanced_object`.
 */
export function extractJson(text: string): { results?: unknown } | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  for (let pos = start; pos < text.length; pos++) {
    if (text[pos] !== "{") continue
    const candidate = balancedObject(text, pos)
    if (candidate === null) continue
    try {
      return JSON.parse(candidate) as { results?: unknown }
    } catch {
      // prose-poisoned candidate; try the next brace
    }
  }
  return null
}

function balancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (c === "\\") {
        escaped = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
    } else if (c === "{") {
      depth++
    } else if (c === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * trim → collapse whitespace → drop control chars → neutralize prompt
 * markers (`<<`, `>>`, `|`, `index=`) → cap at 64 UTF-8 bytes. Marker
 * neutralization mirrors sanitizeField so a label stored via the LLM path
 * renders back into the prompt byte-for-byte (no phantom duplicates on
 * reuse). Neutralizing before the byte cap means the stored value is capped
 * in its final form and truncation can never split a marker run (markers
 * are already collapsed to single chars at that point).
 */
export function sanitizeLabel(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim()
  const noControls = collapsed
    .split("")
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join("")
    .trim()
  if (!noControls) return ""
  const neutralized = neutralizeMarkers(noControls).trim()
  if (!neutralized) return ""
  const bytes = textEncoder.encode(neutralized)
  if (bytes.length <= 64) return neutralized
  let end = 64
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return textDecoder.decode(bytes.subarray(0, end)).trim()
}

/** Truncated prompt transaction for transport-size safety. */
export function toPromptTransaction(
  item: PromptTransaction
): PromptTransaction {
  // `id` is a server-generated UUID, never rendered into the prompt (the
  // user prompt only carries the positional `[i]` index) — passed through
  // untouched so result→row mapping keeps the original id.
  return {
    id: item.id,
    amountCents: item.amountCents,
    counterparty: truncateField(item.counterparty),
    purpose: truncateField(item.purpose),
    bookingDate: truncateField(item.bookingDate),
    suggestions: item.suggestions.map((s) => truncateField(s)),
  }
}
