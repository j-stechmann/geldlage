import { describe, it, expect } from "vitest"
import { collectSse } from "@/lib/llm/sse"

/** Regression (review finding): CRLF-framed SSE bodies must split frames. */
function sseResponse(payload: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(payload))
        c.close()
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  )
}

describe("collectSse frame separators", () => {
  it("splits CRLF-framed bodies into frames", async () => {
    const a = `data: ${JSON.stringify({ delta: { content: "A" } })}`
    const b = `data: ${JSON.stringify({ delta: { content: "B" } })}`
    const frames = await collectSse(sseResponse(`${a}\r\n\r\n${b}\r\n\r\n`))
    expect(frames).toHaveLength(2)
    expect(JSON.parse(frames[0]).delta.content).toBe("A")
    expect(JSON.parse(frames[1]).delta.content).toBe("B")
  })

  it("splits mixed LF/CRLF/CR bodies", async () => {
    const a = `data: ${JSON.stringify({ delta: { content: "A" } })}`
    const b = `data: ${JSON.stringify({ delta: { content: "B" } })}`
    const c = `data: ${JSON.stringify({ delta: { content: "C" } })}`
    const frames = await collectSse(sseResponse(`${a}\n\n${b}\r\n\r\n${c}\r\r`))
    expect(frames).toHaveLength(3)
  })

  it("still handles the final frame without a trailing blank line", async () => {
    const a = `data: ${JSON.stringify({ delta: { content: "A" } })}`
    const frames = await collectSse(sseResponse(`${a}\n\ndata: [DONE]`))
    expect(frames).toHaveLength(1)
  })
})
