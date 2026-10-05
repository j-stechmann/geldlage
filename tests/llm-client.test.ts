import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { resetConfigCache } from "@/lib/config"
import {
  LlmClient,
  LlmHttpError,
  LlmTimeoutError,
  LlmUnreachableError,
  extractJson,
  sanitizeLabel,
  toPromptTransaction,
} from "@/lib/llm/client"
import { sanitizeField, type PromptTransaction } from "@/lib/llm/prompt"

beforeEach(() => {
  // setup.ts pins LLM_MAX_RETRIES=0 for worker tests; retry tests need 2
  process.env.LLM_MAX_RETRIES = "2"
  resetConfigCache()
})

afterEach(() => {
  delete process.env.LLM_MAX_RETRIES
  resetConfigCache()
})

function chatResponse(content: unknown, status = 200): Response {
  const contentStr =
    typeof content === "string" ? content : JSON.stringify(content)
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: contentStr } }],
    }),
    { status }
  )
}

/**
 * Builds an SSE chat-completions Response from content fragments, in the
 * shape llama-server emits for `stream: true`: a role frame, optional
 * reasoning_content frames (must be ignored), one frame per content delta,
 * a final usage frame, and the `data: [DONE]` sentinel. Options: `chunked`
 * emits each frame as its own stream chunk (default); `splitUtf8` cuts
 * chunks mid-UTF-8-sequence to exercise the streaming decoder;
 * `omitFinalNewline` leaves the last data frame unterminated (no trailing
 * blank line); `omitDone` drops the sentinel.
 */
function sseResponse(
  contentFragments: string[],
  opts: {
    status?: number
    reasoning?: string[]
    chunked?: boolean
    splitUtf8?: boolean
    omitFinalNewline?: boolean
    omitDone?: boolean
  } = {}
): Response {
  const {
    status = 200,
    reasoning = [],
    chunked = true,
    splitUtf8 = false,
    omitFinalNewline = false,
    omitDone = false,
  } = opts
  const frames: string[] = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}`,
  ]
  for (const r of reasoning) {
    frames.push(
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: r } }],
      })}`
    )
  }
  for (const fragment of contentFragments) {
    frames.push(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: fragment } }],
      })}`
    )
  }
  // final frame carries usage, not content — must not disturb accumulation
  frames.push(
    `data: ${JSON.stringify({
      choices: [{ delta: {} }],
      usage: { total_tokens: 42 },
    })}`
  )
  if (!omitDone) frames.push("data: [DONE]")

  const payload = frames.map((f) => f + "\n\n").join("")
  const encoder = new TextEncoder()
  let pieces: Uint8Array[]
  if (!chunked) {
    pieces = [encoder.encode(payload)]
  } else if (splitUtf8) {
    pieces = splitUtf8Sequences(encoder.encode(payload))
  } else {
    pieces = frames.map((f) => encoder.encode(f + "\n\n"))
  }
  if (omitFinalNewline && pieces.length > 0) {
    const last = pieces[pieces.length - 1]
    // strip the trailing blank-line terminator off the final chunk
    pieces[pieces.length - 1] = last.subarray(0, last.byteLength - 2)
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece)
        controller.close()
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } }
  )
}

/** Splits raw bytes so multi-byte UTF-8 chars straddle chunk edges. */
function splitUtf8Sequences(bytes: Uint8Array): Uint8Array[] {
  const pieces: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < bytes.length - 1; i++) {
    // cut after the lead byte of any 2-byte sequence (e.g. ä = 0xC3 0xA4)
    if (bytes[i] >= 0xc2 && bytes[i] <= 0xdf) {
      pieces.push(bytes.subarray(start, i + 1))
      start = i + 1
      i++
    }
  }
  pieces.push(bytes.subarray(start))
  return pieces
}

function tx(overrides: Partial<PromptTransaction> = {}): PromptTransaction {
  return {
    id: "tx-1",
    amountCents: -1000,
    counterparty: "REWE",
    purpose: "Einkauf",
    bookingDate: "2026-02-14",
    suggestions: [],
    ...overrides,
  }
}

describe("LlmClient.labelBatch", () => {
  afterEach(() => vi.restoreAllMocks())

  it("parses a clean positional response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 0, label: "Lebensmittel" },
            { index: 1, label: "Miete" },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])

    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "b", label: "Miete" },
    ])
  })

  it("honors echoed indices, ignoring order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 1, label: "Miete" },
            { index: 0, label: "Lebensmittel" },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "b", label: "Miete" },
    ])
  })

  it("drops out-of-range indices instead of shifting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 7, label: "Lebensmittel" },
            { index: 3, label: "Miete" },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    expect(out).toEqual([])
  })

  it("omits slots the model left empty (no neighbor shift)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 0, label: "Lebensmittel" },
            { index: 1, label: "   " },
            { index: 2, label: "Miete" },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
      tx({ id: "c" }),
    ])
    // slot 1 stays empty — "Miete" stays pinned to slot 2 (item c), not b
    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "c", label: "Miete" },
    ])
  })

  it("drops invalid/empty labels and extra results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 0, label: "   " },
            { index: 1, label: "Miete" },
            { index: 9, label: "Extra" },
            { label: 42 },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    // "Miete" pins to slot 1; the empty label skips slot 0; the out-of-range
    // and non-string entries are skipped
    expect(out).toEqual([{ id: "b", label: "Miete" }])
  })

  it("fills unlabeled slots when the model omits indices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [{ label: "Lebensmittel" }, { label: "Miete" }],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "b", label: "Miete" },
    ])
  })

  it("fills open slots around pinned indices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [{ index: 1, label: "Miete" }, { label: "Lebensmittel" }],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
      tx({ id: "c" }),
    ])
    // no-index entry fills slot 0 (first open), pinned "Miete" stays slot 1
    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "b", label: "Miete" },
    ])
  })

  it("extracts JSON from prose-poisoned output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse(
          'Here you go: {"results":[{"index":0,"label":"Miete \\"x\\""}]} hope this helps!'
        )
      )
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: 'Miete "x"' }])
  })

  it("throws LlmHttpError when no JSON is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chatResponse("no json at all"))
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmHttpError)
  })

  it("parses a streamed (SSE) response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"results":[{"index":0,"label":"Lebensmittel"},',
          '{"index":1,"label":"Miete"}]}',
        ])
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "b", label: "Miete" },
    ])
  })

  it("reassembles content split mid-token across SSE deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          '{"results":[{"index":0,"label":"Lebensmit',
          'tel"},{"index":1,"label":"Miete"}]}',
        ])
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "b", label: "Miete" },
    ])
  })

  it("ignores reasoning_content deltas in SSE frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(['{"results":[{"index":0,"label":"Miete"}]}'], {
          // the thinking trace contains a decoy JSON object that must never
          // reach extractJson — only delta.content accumulates
          reasoning: [
            'thinking... maybe {"results":[{"index":0,"label":"DEKOE"}]}',
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Miete" }])
  })

  it("decodes multi-byte UTF-8 labels split across chunk boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(['{"results":[{"index":0,"label":"Zusät', 'zlich"}]}'], {
          splitUtf8: true,
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Zusätzlich" }])
  })

  it("parses an SSE stream whose last frame lacks a trailing blank line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(['{"results":[{"index":0,"label":"Miete"}]}'], {
          omitFinalNewline: true,
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Miete" }])
  })

  it("parses a single-chunk SSE payload with all frames in one read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(['{"results":[{"index":0,"label":"Miete"}]}'], {
          chunked: false,
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Miete" }])
  })

  it("falls back to the non-streaming shape when content-type is not SSE", async () => {
    // stream: true is requested, but a backend/proxy may still answer with a
    // plain JSON body — the parser must accept both
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({ results: [{ index: 0, label: "Miete" }] })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Miete" }])
  })

  it("sends stream: true in the request body", async () => {
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return sseResponse(['{"results":[{"index":0,"label":"Miete"}]}'])
      })
    )

    await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect((captured as { stream: boolean }).stream).toBe(true)
  })

  it("does NOT retry a timeout during the SSE body read", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        // headers (with SSE content-type) resolve immediately; the stream
        // emits one delta, then errors with the same TimeoutError
        // DOMException an AbortSignal.timeout body abort raises
        const frames = [
          `data: ${JSON.stringify({
            choices: [{ delta: { role: "assistant" } }],
          })}\n\n`,
        ]
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(frames[0]))
              queueMicrotask(() =>
                controller.error(new DOMException("timeout", "TimeoutError"))
              )
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
      })
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmTimeoutError)
    expect(calls).toBe(1)
  })

  it("treats an SSE stream with no content deltas as malformed (retried)", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        // only role + usage frames — no delta.content ever arrives
        return sseResponse([])
      })
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmHttpError)
    // LLM_MAX_RETRIES=2 from beforeEach → 3 attempts
    expect(calls).toBe(3)
  })

  it("retries transient 5xx and succeeds", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return calls === 1
          ? new Response("boom", { status: 503 })
          : chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Miete" }])
    expect(calls).toBe(2)
  })

  it("retries 429 with backoff and succeeds", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return calls === 1
          ? new Response("slow down", { status: 429 })
          : chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toHaveLength(1)
  })

  it("fails after exhausting retries on 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 }))
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmHttpError)
  })

  it("retries malformed JSON responses then succeeds", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return calls === 1
          ? chatResponse("prose without json")
          : chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Miete" }])
    expect(calls).toBe(2)
  })

  it("fails after exhausting retries on malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chatResponse("prose without json"))
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmHttpError)
  })

  it("does NOT retry timeouts (no fallback labels)", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            calls++
            const signal = init?.signal as AbortSignal
            signal.addEventListener("abort", () =>
              calls > 0 ? void 0 : undefined
            )
            setTimeout(() => {
              reject(new DOMException("timeout", "TimeoutError"))
            }, 10)
          })
      )
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmTimeoutError)
    expect(calls).toBe(1)
  })

  it("does NOT retry a timeout during the body read", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        // headers resolve immediately; the body stream fails with the same
        // TimeoutError DOMException an AbortSignal.timeout body abort raises
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              queueMicrotask(() =>
                controller.error(new DOMException("timeout", "TimeoutError"))
              )
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      })
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmTimeoutError)
    expect(calls).toBe(1)
  })

  it("retries network errors then throws unreachable", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        throw new Error("ECONNREFUSED")
      })
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmUnreachableError)
    expect(calls).toBe(3) // 1 + LLM_MAX_RETRIES=2
  })

  it("sends json_schema response format with temperature 0", async () => {
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    await new LlmClient("http://test").labelBatch(
      [tx()],
      ["Lebensmittel", "Miete"]
    )

    const body = captured as {
      messages: Array<{ role: string; content: string }>
      temperature: number
      max_tokens: number
      response_format: { type: string }
    }
    expect(body.temperature).toBe(0)
    expect(body.response_format.type).toBe("json_schema")
    expect(body.messages[0].content).toContain("Lebensmittel")
    expect(body.messages[0].content).toContain("Miete")
    // dynamic max_tokens for a batch of 1 stays at the floor
    expect(body.max_tokens).toBe(1024)
  })

  it("scales max_tokens with the batch size", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({
          results: Array.from({ length: 100 }, (_, i) => ({
            index: i,
            label: "X",
          })),
        })
      })
    )

    const items = Array.from({ length: 100 }, (_, i) => tx({ id: `t${i}` }))
    await new LlmClient("http://test").labelBatch(items)
    expect((captured as { max_tokens: number }).max_tokens).toBe(9600)
    warnSpy.mockRestore()
  })

  it("reserves the reasoning budget in max_tokens when reasoning is on", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.LLM_REASONING = "true"
    process.env.LLM_REASONING_BUDGET = "2048"
    resetConfigCache()
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    try {
      await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
      // floor 1024 + reasoning budget 2048 — the thinking trace shares
      // max_tokens, so without the reserve the JSON would truncate
      expect((captured as { max_tokens: number }).max_tokens).toBe(3072)
      // the thinking cap is pinned per request to the reserved budget
      expect(
        (captured as { reasoning_budget_tokens: number })
          .reasoning_budget_tokens
      ).toBe(2048)
    } finally {
      // setup.ts pins LLM_REASONING=false for the reasoning-off tests —
      // restore instead of delete or the next test would see the
      // reasoning-on default
      process.env.LLM_REASONING = "false"
      delete process.env.LLM_REASONING_BUDGET
      resetConfigCache()
      warnSpy.mockRestore()
    }
  })

  it("treats LLM_REASONING=on like true (both spellings are normalized)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.LLM_REASONING = "on"
    process.env.LLM_REASONING_BUDGET = "2048"
    resetConfigCache()
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    try {
      await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
      expect((captured as { max_tokens: number }).max_tokens).toBe(3072)
      expect(
        (captured as { reasoning_budget_tokens: number })
          .reasoning_budget_tokens
      ).toBe(2048)
    } finally {
      process.env.LLM_REASONING = "false"
      delete process.env.LLM_REASONING_BUDGET
      resetConfigCache()
      warnSpy.mockRestore()
    }
  })

  it("does not add the reasoning reserve when reasoning is off", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.LLM_REASONING = "false"
    process.env.LLM_REASONING_BUDGET = "2048"
    resetConfigCache()
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    try {
      await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
      // budget set but reasoning off → plain floor, no reserve added
      expect((captured as { max_tokens: number }).max_tokens).toBe(1024)
      // and no per-request thinking cap is pinned at all
      expect("reasoning_budget_tokens" in (captured as object)).toBe(false)
    } finally {
      process.env.LLM_REASONING = "false"
      delete process.env.LLM_REASONING_BUDGET
      resetConfigCache()
      warnSpy.mockRestore()
    }
  })

  it("treats LLM_REASONING=off like false (both spellings are normalized)", async () => {
    process.env.LLM_REASONING = "off"
    process.env.LLM_REASONING_BUDGET = "2048"
    resetConfigCache()
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    try {
      await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
      expect((captured as { max_tokens: number }).max_tokens).toBe(1024)
      expect("reasoning_budget_tokens" in (captured as object)).toBe(false)
    } finally {
      process.env.LLM_REASONING = "false"
      delete process.env.LLM_REASONING_BUDGET
      resetConfigCache()
    }
  })

  it("accepts a zero reasoning budget when reasoning is off", async () => {
    process.env.LLM_REASONING = "false"
    process.env.LLM_REASONING_BUDGET = "0"
    resetConfigCache()
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    try {
      // the budget is unused with reasoning off — 0 is accepted and the
      // request proceeds with the plain floor
      await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
      expect((captured as { max_tokens: number }).max_tokens).toBe(1024)
    } finally {
      process.env.LLM_REASONING = "false"
      delete process.env.LLM_REASONING_BUDGET
      resetConfigCache()
    }
  })

  it("rejects a zero reasoning budget when reasoning is on", async () => {
    process.env.LLM_REASONING = "true"
    process.env.LLM_REASONING_BUDGET = "0"
    resetConfigCache()

    try {
      await expect(
        new LlmClient("http://test").labelBatch([tx()])
      ).rejects.toThrow(/LLM_REASONING_BUDGET.*must be >= 1/)
    } finally {
      process.env.LLM_REASONING = "false"
      delete process.env.LLM_REASONING_BUDGET
      resetConfigCache()
    }
  })

  it("rejects a zero reasoning budget when reasoning defaults to on", async () => {
    delete process.env.LLM_REASONING // app default is now true
    process.env.LLM_REASONING_BUDGET = "0"
    resetConfigCache()

    try {
      await expect(
        new LlmClient("http://test").labelBatch([tx()])
      ).rejects.toThrow(/LLM_REASONING_BUDGET.*must be >= 1/)
    } finally {
      process.env.LLM_REASONING = "false"
      delete process.env.LLM_REASONING_BUDGET
      resetConfigCache()
    }
  })

  it("warns when prompt + completion exceed the context window", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({ results: [{ index: 0, label: "Miete" }] })
      )
    )

    // 100 items → max_tokens 9600, prompt adds ~3k more → over LLM_CTX 8192
    const items = Array.from({ length: 100 }, (_, i) => tx({ id: `t${i}` }))
    await new LlmClient("http://test").labelBatch(items)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("LLM_CTX")
    warnSpy.mockRestore()
  })

  it("does not warn when the budget fits the context window", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({ results: [{ index: 0, label: "Miete" }] })
      )
    )

    await new LlmClient("http://test").labelBatch([tx()])
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("LlmClient.health", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reports ok on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    )
    expect(await new LlmClient("http://test").health()).toBe("ok")
  })

  it("reports unreachable on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("nope")
      })
    )
    expect(await new LlmClient("http://test").health()).toBe("unreachable")
  })
})

describe("extractJson", () => {
  it("handles braces inside strings", () => {
    const out = extractJson('{"results":[{"index":0,"label":"a{b}c"}]}')
    expect(out).toEqual({ results: [{ index: 0, label: "a{b}c" }] })
  })

  it("returns null for garbage", () => {
    expect(extractJson("no object here")).toBeNull()
    expect(extractJson("{not json")).toBeNull()
  })
})

describe("sanitizeLabel", () => {
  it("trims, collapses whitespace, strips controls, caps at 64 bytes", () => {
    expect(sanitizeLabel("  Lebensmittel  ")).toBe("Lebensmittel")
    expect(sanitizeLabel("a\u0007b   c")).toBe("ab c")
    expect(sanitizeLabel("ä".repeat(64)).length).toBeLessThan(64)
    expect(new TextEncoder().encode(sanitizeLabel("ä".repeat(64))).length).toBe(
      64
    )
    expect(sanitizeLabel("   ")).toBe("")
  })

  it("neutralizes prompt markers so stored labels render back verbatim", () => {
    expect(sanitizeLabel("Miete | Nebenkosten")).toBe("Miete / Nebenkosten")
    expect(sanitizeLabel("a<<<b")).toBe("a<b")
    expect(sanitizeLabel("a<<<<b")).toBe("a<b")
    expect(sanitizeLabel("index=0")).toBe("index 0")
    // the sanitized form must survive sanitizeField unchanged
    for (const input of ["Miete | Nebenkosten", "a<<<b", "a>>>>b", "index=0"]) {
      const stored = sanitizeLabel(input)
      expect(sanitizeField(stored)).toBe(stored)
    }
  })
})

describe("toPromptTransaction", () => {
  it("truncates oversized fields", () => {
    const out = toPromptTransaction(
      tx({ purpose: "x".repeat(600), counterparty: "ä".repeat(600) })
    )
    expect(out.purpose.length).toBeLessThanOrEqual(512)
    expect(
      new TextEncoder().encode(out.counterparty).length
    ).toBeLessThanOrEqual(512)
  })

  it("keeps suggestions and truncates each", () => {
    const out = toPromptTransaction(
      tx({ suggestions: ["Miete", "y".repeat(600)] })
    )
    expect(out.suggestions[0]).toBe("Miete")
    expect(out.suggestions[1].length).toBeLessThanOrEqual(512)
  })
})
