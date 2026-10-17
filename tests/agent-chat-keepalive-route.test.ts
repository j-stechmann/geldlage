import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as chatRoute } from "@/app/api/agent/threads/[id]/chat/route"
import { SSE_KEEPALIVE_INTERVAL_MS } from "@/lib/agent/sse-writer"
import { createThread, renameThread } from "@/lib/agent/store"
import { authedRequest, setupTestDb } from "./helpers"

/**
 * Route integration pin of the SSE keepalive wiring (ADR-0033 amendment
 * 2026-10-16): the watchdog itself is unit-tested in agent-sse-writer;
 * these tests pin the route's half of the contract, invisible to unit
 * tests — arm after the `user` frame, ping through the silent LLM wait,
 * re-arm per loop event, nothing after `done`. The loop is mocked at the
 * seam with a scripted async generator (the silent gap the keepalive
 * exists for is the wait before the loop's first event) and the fake
 * clock drives the watchdog alone. The thread is renamed upfront so
 * auto-titling — the only other LLM consumer on this path — bails at
 * the default-title guard without a fetch.
 */

const URL_BASE = "https://app.example.com"

const { mockTurn, releaseTurn, setTurnSteps } = vi.hoisted(() => {
  interface TurnStep {
    /** Fake-clock ms to wait before the step resolves. */
    waitMs?: number
    /** Park the turn until releaseTurn() — the "LLM is thinking" wait. */
    gate?: true
    /** Yield a content delta instead of gating. */
    text?: string
  }
  const gates: Array<() => void> = []
  let steps: TurnStep[] = []
  return {
    setTurnSteps(next: TurnStep[]): void {
      steps = next
    },
    releaseTurn(): void {
      gates.shift()?.()
    },
    async *mockTurn() {
      for (const step of steps) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, step.waitMs ?? 0)
        )
        if (step.gate) {
          await new Promise<void>((resolve) => gates.push(resolve))
        } else if (step.text !== undefined) {
          yield { type: "content" as const, text: step.text }
        }
      }
      yield { type: "done" as const }
    },
  }
})

vi.mock("@/lib/agent/loop", () => ({
  runAgentTurn: () => mockTurn(),
}))

describe("POST /chat → SSE keepalive wiring", () => {
  let userId: number
  let threadId: string

  beforeEach(() => {
    ;({ userId } = setupTestDb())
    threadId = createThread(userId, "Neuer Chat").id
    renameThread(threadId, "Mein Chat")
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function send(): Promise<Response> {
    const request = await authedRequest(
      `${URL_BASE}/api/agent/threads/${threadId}/chat`,
      userId,
      { method: "POST", body: { content: "Wie steht mein Budget?" } }
    )
    vi.useFakeTimers()
    return chatRoute(request, { params: Promise.resolve({ id: threadId }) })
  }

  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let body = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
    }
    return body + decoder.decode()
  }

  it("pings comment frames through the silent wait, none after done", async () => {
    setTurnSteps([{ gate: true }])
    const res = await send()
    expect(res.status).toBe(200)

    // 45.5s of loop silence: pings at 15/30/45s, and the watchdog
    // re-armed for t+60s stays out of the window.
    await vi.advanceTimersByTimeAsync(3 * SSE_KEEPALIVE_INTERVAL_MS + 500)
    releaseTurn()

    const body = await readAll(res.body!)
    expect(body.split(": keepalive\n\n").length - 1).toBe(3)
    // The user frame opened the stream, the done frame closed it, and
    // every keepalive sits between them.
    expect(body.startsWith("event: user\n")).toBe(true)
    expect(body.endsWith('event: done\ndata: {"messageId":null}\n\n')).toBe(
      true
    )
    const lastKeepaliveAt = body.lastIndexOf(": keepalive\n\n")
    expect(lastKeepaliveAt).toBeGreaterThan(0)
    expect(lastKeepaliveAt).toBeLessThan(body.indexOf("event: done\n"))
  })

  it("re-arms per loop event — a streaming turn never pings", async () => {
    setTurnSteps([
      { waitMs: 14_000, text: "a" },
      { waitMs: 14_000, text: "b" },
      { waitMs: 14_000, text: "c" },
      { waitMs: 14_000, text: "d" },
      { waitMs: 14_000, text: "e" },
    ])
    const res = await send()

    // Deltas every 14s re-arm the 15s window before it can elapse.
    await vi.advanceTimersByTimeAsync(70_000)

    const body = await readAll(res.body!)
    expect(body).not.toContain(": keepalive")
    expect(body.split("event: delta\n").length - 1).toBe(5)
    expect(body.endsWith('event: done\ndata: {"messageId":null}\n\n')).toBe(
      true
    )
  })
})
