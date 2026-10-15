import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { Server } from "node:http"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { resetConfigCache } from "@/lib/config"
import { runAgentTurn } from "@/lib/agent/loop"
import {
  AGENT_MAX_FIELD_CHARS,
  AGENT_MAX_TURNS,
  windowHistory,
} from "@/lib/agent/window"
import { setTestDb, createTestDb, type Db } from "@/lib/db"
import type { AgentChatMessage, AgentLoopEvent } from "@/lib/agent/types"
import { seedUser } from "./helpers"

/**
 * Loop tests (ADR-0033): a mock llama-server plays /v1/chat/completions
 * per request (scripted responses queue), so the loop's round behavior —
 * tool execution, protocol trio, round events (one per model round, the
 * per-round transcript the persister writes), round cap, estimate-based
 * windowing — is exercised against the real streaming path (stream: true
 * + SSE frames).
 */

/** Round events off a collected event list, in order. */
function roundsOf(events: AgentLoopEvent[]) {
  return events.filter((e) => e.type === "round")
}

let db: Db
let server: Server | null = null
let baseUrl = ""
/** Scripted responses: one entry per incoming POST request. */
let scripted: Array<{
  reasoning?: string[]
  content?: string[]
  toolCalls?: Array<{
    index: number
    id: string
    name: string
    arguments: string
  }>
  /** Frame JSON spread across multiple SSE chunks to exercise accumulation. */
  chunked?: {
    index: number
    id: string
    name: string
    argsPieces: string[]
  }
}> = []
/** Captured request bodies, in arrival order. */
let requests: Array<Record<string, unknown>> = []

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  resetConfigCache()
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })
  server = null
  scripted = []
  requests = []
  resetConfigCache()
  vi.restoreAllMocks()
})

/** Picks up LLM_BASE_URL from env (setup/this file) into the config cache. */
function setBaseUrl(url: string) {
  process.env.LLM_BASE_URL = url
  resetConfigCache()
}

/** Starts the mock server on an ephemeral port; sets LLM_BASE_URL. */
async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >
      requests.push(body)
      const next = scripted[requests.length - 1]
      if (!next) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "no script" }))
        return
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const frames: string[] = []
      if (next.chunked) {
        // args streamed in pieces: id+name first, then argument fragments
        frames.push(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: next.chunked.index,
                      id: next.chunked.id,
                      function: {
                        name: next.chunked.name,
                        arguments: "",
                      },
                    },
                  ],
                },
              },
            ],
          })}`
        )
        for (const piece of next.chunked.argsPieces) {
          frames.push(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: next.chunked.index,
                        function: { arguments: piece },
                      },
                    ],
                  },
                },
              ],
            })}`
          )
        }
      } else if (next.toolCalls) {
        // real OpenAI wire shape: nested function object
        frames.push(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: next.toolCalls.map((c) => ({
                    index: c.index,
                    id: c.id,
                    function: { name: c.name, arguments: c.arguments },
                  })),
                },
              },
            ],
          })}`
        )
      }
      for (const r of next.reasoning ?? []) {
        frames.push(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: r } }],
          })}`
        )
      }
      for (const c of next.content ?? []) {
        frames.push(
          `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`
        )
      }
      frames.push("data: [DONE]")
      res.write(frames.map((f) => f + "\n\n").join(""))
      res.end()
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  setBaseUrl(baseUrl)
}

/** Collects all loop events into a list for assertions. */
async function collect(
  history: AgentChatMessage[],
  uid = 1
): Promise<AgentLoopEvent[]> {
  const events: AgentLoopEvent[] = []
  for await (const ev of runAgentTurn({ history, uid })) events.push(ev)
  return events
}

describe("runAgentTurn", () => {
  it("streams a pure answer without tools", async () => {
    await startServer()
    scripted = [{ content: ["Hal", "lo"] }]
    const events = await collect([{ role: "user", content: "Hallo?" }])

    expect(events.filter((e) => e.type === "content")).toEqual([
      { type: "content", text: "Hal" },
      { type: "content", text: "lo" },
    ])
    // One round event per model round: the persister's row unit.
    expect(roundsOf(events)).toEqual([
      {
        type: "round",
        content: "Hallo",
        reasoning: null,
        calls: [],
        retry: false,
      },
    ])
    expect(events[events.length - 1].type).toBe("done")
    expect(
      events.some((e) => e.type === "tool_call" || e.type === "tool_result")
    ).toBe(false)
    // system prompt on top, tools attached, history echoed
    expect(requests).toHaveLength(1)
    const msgs = requests[0].messages as Array<{
      role: string
      content: string
    }>
    expect(msgs[0].role).toBe("system")
    const wireTools = requests[0].tools as Array<{
      function: { name: string }
    }>
    expect(wireTools[0].function.name).toBe("get_category_totals")
    expect(msgs[msgs.length - 1].content).toBe("Hallo?")
  })

  it("executes a tool round: protocol trio on the follow-up request", async () => {
    await startServer()
    scripted = [
      {
        chunked: {
          index: 0,
          id: "call_1",
          name: "get_category_totals",
          argsPieces: ['{"period', '":"this_month"}'],
        },
      },
      { content: ["Hier sind deine Summen."] },
    ]
    const events = await collect([{ role: "user", content: "Summen?" }])

    const callIdx = events.findIndex((e) => e.type === "tool_call")
    const resultIdx = events.findIndex((e) => e.type === "tool_result")
    expect(callIdx).toBeGreaterThanOrEqual(0)
    expect(resultIdx).toBe(callIdx + 1)
    const call = events[callIdx]
    if (call.type === "tool_call") {
      expect(call.name).toBe("get_category_totals")
      expect(call.args).toBe('{"period":"this_month"}')
    }
    const result = events[resultIdx]
    if (result.type === "tool_result") {
      // the tool actually executed against the test DB → its JSON shape
      expect(() => JSON.parse(result.result)).not.toThrow()
      const parsed = JSON.parse(result.result) as {
        categories?: unknown[]
        totalsCents?: unknown
      }
      expect(Array.isArray(parsed.categories)).toBe(true)
    }
    // Per-round transcript: round 1 is prose-less but carries its call,
    // round 2 is the final answer with no calls.
    const rounds = roundsOf(events)
    expect(rounds[0]).toMatchObject({
      type: "round",
      content: "",
      reasoning: null,
      calls: [
        {
          id: "call_1",
          name: "get_category_totals",
          args: '{"period":"this_month"}',
        },
      ],
    })
    expect(rounds[1]).toMatchObject({
      type: "round",
      content: "Hier sind deine Summen.",
      calls: [],
    })
    expect(events[events.length - 1].type).toBe("done")

    expect(requests).toHaveLength(2)
    const second = requests[1].messages as Array<{
      role: string
      tool_calls?: Array<{ id?: string }>
      tool_call_id?: string
    }>
    expect(second[0].role).toBe("system")
    const assistantCall = second.find((m) => Array.isArray(m.tool_calls))
    expect(assistantCall?.tool_calls?.[0].id).toBe("call_1")
    const toolMsg = second.find((m) => m.role === "tool")
    expect(toolMsg?.tool_call_id).toBe("call_1")
    // the tool message carries the executed result JSON
    expect(String((toolMsg as { content?: string }).content)).toContain(
      '"period"'
    )
  })

  it("caps rounds at AGENT_MAX_TURNS and strips tools on the final request", async () => {
    await startServer()
    // AGENT_MAX_TURNS tool-rounds + the tools-free final round
    scripted = [
      ...Array.from({ length: AGENT_MAX_TURNS - 1 }, (_, i) => ({
        toolCalls: [
          {
            index: 0,
            id: `call_${i}`,
            name: "get_category_totals",
            arguments: '{"period":"this_month"}',
          },
        ],
      })),
      { content: ["Schluss."] },
    ]
    const events = await collect([{ role: "user", content: "loop" }])

    // AGENT_MAX_TURNS - 1 tool rounds + 1 final tools-free round
    expect(requests).toHaveLength(AGENT_MAX_TURNS)
    const final = requests[requests.length - 1] as {
      tools?: unknown
    }
    expect(final.tools).toBeUndefined()
    // one round event per model round, the last carries the final answer
    const rounds = roundsOf(events)
    expect(rounds).toHaveLength(AGENT_MAX_TURNS)
    expect(rounds[rounds.length - 1]).toMatchObject({
      type: "round",
      content: "Schluss.",
      calls: [],
    })
    expect(events[events.length - 1].type).toBe("done")
    // rounds 1..(N-1) executed the tool; the final round's calls are not made
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(
      AGENT_MAX_TURNS - 1
    )
  })

  it("windows history to the token budget, anchored at a user message", async () => {
    await startServer()
    // Explicit ctx for a deterministic budget: 8192 tokens × 4 chars ×
    // 0.5 share = 16384 chars. Each message below estimates ~824 chars
    // (content + 20 envelope), so the 19 newest fit (824 × 19 ≤ 16384,
    // × 20 overruns) and the anchor shifts to the first user message
    // inside that fitted run (index 12; 11 is an assistant row).
    const prevCtx = process.env.LLM_CTX
    process.env.LLM_CTX = "8192"
    try {
      resetConfigCache()
      scripted = [{ content: ["ok"] }]
      const history: AgentChatMessage[] = []
      for (let i = 0; i < 30; i++) {
        history.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}-` + "x".repeat(800),
        })
      }
      await collect(history)
      const msgs = requests[0].messages as Array<{
        role: string
        content: string
      }>
      const historyMsgs = msgs.slice(1)
      expect(historyMsgs).toHaveLength(18) // 12..29
      expect(historyMsgs[0].role).toBe("user")
      expect(historyMsgs[0].content.startsWith("m12-")).toBe(true)
      expect(
        historyMsgs[historyMsgs.length - 1].content.startsWith("m29-")
      ).toBe(true)
      const all = historyMsgs.map((m) => m.content).join("|")
      expect(all).not.toContain("m0-")
      expect(all).not.toContain("m11-")
    } finally {
      if (prevCtx === undefined) delete process.env.LLM_CTX
      else process.env.LLM_CTX = prevCtx
      resetConfigCache()
    }
  })

  it("sends the full history when it fits the budget", async () => {
    await startServer()
    scripted = [{ content: ["ok"] }]
    const history: AgentChatMessage[] = []
    for (let i = 0; i < 30; i++) {
      history.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      })
    }
    await collect(history)
    const msgs = requests[0].messages as Array<{
      role: string
      content: string
    }>
    const historyMsgs = msgs.slice(1)
    expect(historyMsgs).toHaveLength(30)
    expect(historyMsgs[0].content).toBe("m0")
    expect(historyMsgs[historyMsgs.length - 1].content).toBe("m29")
  })

  it("yields per-round reasoning on the round event", async () => {
    await startServer()
    scripted = [{ reasoning: ["Denk", "...nach"], content: ["Antwort"] }]
    const events = await collect([{ role: "user", content: "q" }])

    expect(events.filter((e) => e.type === "reasoning")).toEqual([
      { type: "reasoning", text: "Denk" },
      { type: "reasoning", text: "...nach" },
    ])
    expect(roundsOf(events)).toEqual([
      {
        type: "round",
        content: "Antwort",
        reasoning: "Denk...nach",
        calls: [],
        retry: false,
      },
    ])
  })

  it("resets reasoning per round (traces never merge across rounds)", async () => {
    await startServer()
    scripted = [
      {
        reasoning: ["r1"],
        content: ["Ich prüfe das."],
        toolCalls: [
          {
            index: 0,
            id: "call_r",
            name: "get_category_totals",
            arguments: '{"period":"this_month"}',
          },
        ],
      },
      { reasoning: ["r2"], content: ["Fertig."] },
    ]
    const events = await collect([{ role: "user", content: "q" }])
    const rounds = roundsOf(events)
    expect(rounds[0]).toMatchObject({
      content: "Ich prüfe das.",
      reasoning: "r1",
    })
    expect(rounds[1]).toMatchObject({ content: "Fertig.", reasoning: "r2" })
  })

  it("retries tools-free after an empty answer, then ends", async () => {
    await startServer()
    scripted = [{ content: [] }, { content: ["Eins"] }]
    const events = await collect([{ role: "user", content: "q" }])

    expect(requests).toHaveLength(2)
    expect((requests[1] as { tools?: unknown }).tools).toBeUndefined()
    // the degenerate empty round announces itself retry-flagged (the
    // persister skips it), the retry round carries the answer
    const rounds = roundsOf(events)
    expect(rounds[0]).toEqual({
      type: "round",
      content: "",
      reasoning: null,
      calls: [],
      retry: true,
    })
    expect(rounds[1]).toMatchObject({ type: "round", content: "Eins" })
    expect(events[events.length - 1].type).toBe("done")
  })

  it("retry-flags a reasoning-only degenerate round (persister row skip)", async () => {
    await startServer()
    // Regression: a tools-allowed round streaming ONLY a thinking trace
    // takes the empty-answer retry. Reasoning is present, so the
    // persister's fully-empty skip does not apply — the retry flag is
    // what keeps the placeholder row out of the transcript (the row
    // side is asserted in tests/agent-threads-api.test.ts).
    scripted = [{ reasoning: ["hmm…"] }, { content: ["Eins"] }]
    const events = await collect([{ role: "user", content: "q" }])

    expect(requests).toHaveLength(2)
    expect((requests[1] as { tools?: unknown }).tools).toBeUndefined()
    const rounds = roundsOf(events)
    expect(rounds[0]).toEqual({
      type: "round",
      content: "",
      reasoning: "hmm…",
      calls: [],
      retry: true,
    })
    expect(rounds[1]).toMatchObject({ content: "Eins", retry: false })
    expect(events[events.length - 1].type).toBe("done")
  })

  it("runs the tool with the requesting uid (isolation through the loop)", async () => {
    await startServer()
    const uid = seedUser(db, "iso-user")
    scripted = [
      {
        chunked: {
          index: 0,
          id: "c1",
          name: "get_category_totals",
          argsPieces: ['{"period":"this_month"}'],
        },
      },
      { content: ["fertig"] },
    ]
    const events = await collect([{ role: "user", content: "?" }], uid)
    expect(events.some((e) => e.type === "tool_result")).toBe(true)
    const toolMsg = (
      requests[1].messages as Array<{ role: string; content?: string }>
    ).find((m) => m.role === "tool")
    // the seeded user has no transactions → empty categories, executed as them
    const parsed = JSON.parse(String(toolMsg?.content)) as {
      categories: unknown[]
    }
    expect(parsed.categories).toEqual([])
  })

  it("synthesizes a tool_call id when the stream omits one", async () => {
    await startServer()
    // Regression for the accumulator's empty-id path: a delta series that
    // carries name+args but never an id must still produce a usable
    // tool_call_id in the protocol trio (same call_<n> scheme as the
    // non-streaming fold).
    scripted = [
      {
        chunked: {
          index: 0,
          id: "",
          name: "get_category_totals",
          argsPieces: ['{"period', '":"this_month"}'],
        },
      },
      { content: ["ok"] },
    ]
    const events = await collect([{ role: "user", content: "Summen?" }])

    const call = events.find((e) => e.type === "tool_call")
    if (call?.type === "tool_call")
      expect(call.args).toBe('{"period":"this_month"}')
    // the synthesized id flows into the round event's calls record
    expect(roundsOf(events)[0]).toMatchObject({
      calls: [{ id: expect.stringMatching(/^call_\d+$/) }],
    })
    expect(requests).toHaveLength(2)
    const second = requests[1].messages as Array<{
      role: string
      tool_calls?: Array<{ id?: string }>
      tool_call_id?: string
    }>
    const assistantCall = second.find((m) => Array.isArray(m.tool_calls))
    expect(assistantCall?.tool_calls?.[0].id).toMatch(/^call_\d+$/)
    expect(assistantCall?.tool_calls?.[0].id).not.toBe("")
    const toolMsg = second.find((m) => m.role === "tool")
    expect(toolMsg?.tool_call_id).toBe(assistantCall?.tool_calls?.[0].id)
  })
})

describe("windowHistory unit", () => {
  it("returns empty when no user message exists in the window", () => {
    const msgs: AgentChatMessage[] = Array.from({ length: 30 }, () => ({
      role: "assistant",
      content: "a",
    }))
    expect(windowHistory(msgs, 10_000)).toEqual([])
  })

  it("truncates overlong fields with the ellipsis suffix", () => {
    const long = "x".repeat(AGENT_MAX_FIELD_CHARS + 50)
    // newest message is kept even when it alone exceeds the budget
    const out = windowHistory([{ role: "user", content: long }], 1_000)
    expect(out[0].content.length).toBe(AGENT_MAX_FIELD_CHARS + 1) // + "…"
    expect(out[0].content.endsWith("…")).toBe(true)
  })

  it("fits the newest run under the budget, then anchors at a user message", () => {
    // m0..m9, alternating user/assistant (even = user), each estimates
    // 2 + 20 = 22 chars. Budget 110 fits 5 (indices 5..9, 110 ≤ 110),
    // the anchor then shifts to the first user row inside (index 6).
    const msgs: AgentChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }))
    const out = windowHistory(msgs, 110)
    expect(out.map((m) => m.content)).toEqual(["m6", "m7", "m8", "m9"])
  })

  it("keeps a complete protocol trio intact across the budget walk", () => {
    // The trio (assistant with tool_calls + its tool rows) must never be
    // split by the walk: the anchor drops the whole older turn together.
    const trio: AgentChatMessage[] = [
      { role: "user", content: "old question" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_x",
            type: "function",
            function: { name: "get_category_totals", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_x",
        name: "get_category_totals",
        content: "r1",
      },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
    ]
    // Budget that excludes the old turn entirely: only the new question fits.
    const tight = windowHistory(trio, 40)
    expect(tight.map((m) => m.content)).toEqual(["new question"])
    // A budget including the trio keeps it complete, anchored at the user row.
    const wide = windowHistory(trio, 200)
    expect(wide.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ])
  })
})
