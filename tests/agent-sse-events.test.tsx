// @vitest-environment jsdom
/**
 * Client SSE dispatcher tests (ADR-0033): the named-frame protocol
 * (delta/reasoning/tool_call/tool_result/done/error) parsed through the
 * shared lib/llm/sse generator. Includes the CRLF reframe regression the
 * shared parser guarantees.
 */
import { describe, it, expect } from "vitest"
import { parseAgentSse } from "@/components/agent/sse-events"
import { sseFrames } from "./helpers-dom"

function sseResponse(body: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
}

async function collect(body: string) {
  const events = []
  for await (const ev of parseAgentSse(sseResponse(body))) events.push(ev)
  return events
}

describe("parseAgentSse", () => {
  it("dispatches all six event types by name", async () => {
    const body = sseFrames([
      { event: "reasoning", data: { text: "denke" } },
      { event: "delta", data: { text: "Hallo" } },
      {
        event: "tool_call",
        data: { name: "get_category_totals", args: '{"period":"this_month"}' },
      },
      {
        event: "tool_result",
        data: { name: "get_category_totals", result: "{}" },
      },
      { event: "done", data: { messageId: "m1", content: "Hallo" } },
    ])
    const events = await collect(body)
    expect(events.map((e) => e.type)).toEqual([
      "reasoning",
      "delta",
      "tool_call",
      "tool_result",
      "done",
    ])
    expect(events[2]).toEqual({
      type: "tool_call",
      name: "get_category_totals",
      args: '{"period":"this_month"}',
    })
    expect(events[4]).toEqual({ type: "done", messageId: "m1" })
  })

  it("maps error frames to their message", async () => {
    const events = await collect(
      sseFrames([
        {
          event: "error",
          data: { message: "Timeout — die Antwort dauerte zu lange." },
        },
      ])
    )
    expect(events).toEqual([
      { type: "error", message: "Timeout — die Antwort dauerte zu lange." },
    ])
  })

  it("routes by event NAME, not payload content", async () => {
    // a delta whose text contains "event: done" must stay a delta
    const body = sseFrames([
      { event: "delta", data: { text: 'event: done\ndata: {"hacked":true}' } },
      { event: "done", data: { messageId: null } },
    ])
    const events = await collect(body)
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe("delta")
    expect(events[1].type).toBe("done")
  })

  it("skips malformed data frames without aborting", async () => {
    const events = await collect(
      sseFrames([{ event: "delta", data: { text: "a" } }]) +
        "event: delta\ndata: not-json\n\n" +
        sseFrames([{ event: "delta", data: { text: "b" } }])
    )
    expect(events.map((e) => (e as { text: string }).text).join("")).toBe("ab")
  })

  it("tolerates CRLF reframing (proxy regression)", async () => {
    const lf = sseFrames([{ event: "delta", data: { text: "x" } }])
    const crlf = lf.replace(/\n\n/g, "\r\n\r\n")
    const events = await collect(crlf)
    expect(events).toEqual([{ type: "delta", text: "x" }])
  })
})
