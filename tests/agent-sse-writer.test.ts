import { describe, it, expect, afterEach, vi } from "vitest"
import {
  enqueueFrame,
  errorFrameMessage,
  sseFrame,
} from "@/lib/agent/sse-writer"

/**
 * SSE writer tests (ADR-0033): enqueueFrame's client-disconnect
 * classification — a frame hitting an already-cancelled response stream
 * must surface as client-gone (no error frame, no phantom
 * "[agent] LLM turn failed" log), the same treatment a request.signal
 * abort gets.
 */

const decoder = new TextDecoder()

afterEach(() => {
  vi.restoreAllMocks()
})

describe("enqueueFrame", () => {
  it("delivers frames while the stream is live", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueueFrame(controller, "delta", { text: "hi" })
        controller.close()
      },
    })
    const bytes = await new Response(stream).arrayBuffer()
    expect(decoder.decode(bytes)).toBe(decoder.decode(sseFrame("delta", { text: "hi" })))
  })

  it("classifies a cancelled stream as client-gone, not an LLM failure", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {})
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    await stream.cancel() // client gone: cancellation wins the signal race
    let thrown: unknown
    try {
      enqueueFrame(controller, "delta", { text: "late" })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe("AbortError")
    // No error frame AND no server-side log — the turn simply lost its reader
    expect(errorFrameMessage(thrown)).toBeNull()
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe("errorFrameMessage", () => {
  it("logs and frames genuine failures", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {})
    const message = errorFrameMessage(new Error("llama-server exploded"))
    expect(message).not.toBeNull()
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it("stays silent on request.signal aborts", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {})
    expect(
      errorFrameMessage(new DOMException("aborted", "AbortError"))
    ).toBeNull()
    expect(consoleError).not.toHaveBeenCalled()
  })
})