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
 * tool execution, protocol trio, round cap, windowing — is exercised
 * against the real streaming path (stream: true + SSE frames).
 */

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
    const done = events[events.length - 1]
    expect(done.type).toBe("done")
    if (done.type === "done") {
      expect(done.content).toBe("Hallo")
      expect(done.reasoning).toBeNull()
    }
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
    const done = events[events.length - 1]
    if (done.type === "done")
      expect(done.content).toBe("Hier sind deine Summen.")

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
    const done = events[events.length - 1]
    expect(done.type).toBe("done")
    if (done.type === "done") expect(done.content).toBe("Schluss.")
    // rounds 1..(N-1) executed the tool; the final round's calls are not made
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(
      AGENT_MAX_TURNS - 1
    )
  })

  it("windows history to the last anchor + trailing messages", async () => {
    await startServer()
    scripted = [{ content: ["ok"] }]
    const history: AgentChatMessage[] = []
    history.push({ role: "user", content: "m0-FIRST-MARKER" })
    for (let i = 1; i < 30; i++) {
      history.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      })
    }
    // ensure the final message is a user message (the anchor)
    history[29] = { role: "user", content: "m29-LAST-MARKER" }

    await collect(history)
    const msgs = requests[0].messages as Array<{
      role: string
      content: string
    }>
    const historyMsgs = msgs.slice(1)
    expect(historyMsgs.length).toBeLessThanOrEqual(24)
    expect(historyMsgs[0].role).toBe("user")
    expect(historyMsgs[historyMsgs.length - 1].content).toBe("m29-LAST-MARKER")
    const all = historyMsgs.map((m) => m.content).join("|")
    expect(all).not.toContain("m0-FIRST-MARKER")
  })

  it("accumulates reasoning into done and yields reasoning events", async () => {
    await startServer()
    scripted = [{ reasoning: ["Denk", "...nach"], content: ["Antwort"] }]
    const events = await collect([{ role: "user", content: "q" }])

    expect(events.filter((e) => e.type === "reasoning")).toEqual([
      { type: "reasoning", text: "Denk" },
      { type: "reasoning", text: "...nach" },
    ])
    const done = events[events.length - 1]
    if (done.type === "done") {
      expect(done.reasoning).toBe("Denk...nach")
      expect(done.content).toBe("Antwort")
    }
  })

  it("retries tools-free after an empty answer, then ends", async () => {
    await startServer()
    scripted = [{ content: [] }, { content: ["Eins"] }]
    const events = await collect([{ role: "user", content: "q" }])

    expect(requests).toHaveLength(2)
    expect((requests[1] as { tools?: unknown }).tools).toBeUndefined()
    const done = events[events.length - 1]
    if (done.type === "done") expect(done.content).toBe("Eins")
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
    expect(windowHistory(msgs)).toEqual([])
  })

  it("truncates overlong fields with the ellipsis suffix", () => {
    const long = "x".repeat(AGENT_MAX_FIELD_CHARS + 50)
    const out = windowHistory([{ role: "user", content: long }])
    expect(out[0].content.length).toBe(AGENT_MAX_FIELD_CHARS + 1) // + "…"
    expect(out[0].content.endsWith("…")).toBe(true)
  })
})
