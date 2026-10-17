import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { resetConfigCache } from "@/lib/config"
import { setupTestDb, authedRequest, seedUser } from "./helpers"
import { POST as chatRoute } from "@/app/api/agent/threads/[id]/chat/route"
import { createThread, getThread } from "@/lib/agent/store"

/**
 * Route integration (ADR-0033): the chat route fires AI titling after the
 * FIRST completed turn only — the mock server distinguishes the title
 * one-shot (prompt contains "Chat-Titel") from the agent turn by the
 * prompt content and counts calls.
 */

const URL_BASE = "https://app.example.com"

describe("POST /chat → auto-titling", () => {
  let db: ReturnType<typeof setupTestDb>["db"]
  let server: Server | null = null
  let requests: Array<Record<string, unknown>> = []
  let threadId = ""

  beforeEach(() => {
    ;({ db } = setupTestDb())
    requests = []
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = null
    resetConfigCache()
  })

  /** Mock llama-server: turn turns answer "42.", title calls "Die Antwort". */
  async function startMock(): Promise<void> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf8")
        ) as Record<string, unknown>
        requests.push(body)
        const isTitleCall = (body.messages as unknown[]).some((m) =>
          String((m as { content?: string }).content ?? "").includes(
            "Chat-Titel"
          )
        )
        const answer = isTitleCall ? "Die Antwort" : "Die Antwort lautet 42."
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: answer } }],
          })}\n\ndata: [DONE]\n\n`
        )
        res.end()
      })
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve)
    )
    const port = (server.address() as AddressInfo).port
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`
    resetConfigCache()
    const thread = createThread(1, "Neuer Chat")
    threadId = thread.id
  }

  async function send(content: string): Promise<void> {
    const uid = db
      .select()
      .from((await import("@/lib/db/schema")).users)
      .all()[0].id
    const res = await chatRoute(
      await authedRequest(
        `${URL_BASE}/api/agent/threads/${threadId}/chat`,
        uid,
        { method: "POST", body: { content } }
      ),
      { params: Promise.resolve({ id: threadId }) }
    )
    await res.text()
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 10))
  }

  it("titles after the first turn via the model, not after the second", async () => {
    await startMock()
    seedUser(db, "u")
    await send("Erste Frage")
    await settle()
    expect(getThread(threadId)?.title).toBe("Die Antwort")
    // 1 agent turn + 1 title one-shot
    expect(requests).toHaveLength(2)

    await send("Zweite Frage")
    await settle()
    // only the agent turn — no second title call
    expect(requests).toHaveLength(3)
    expect(getThread(threadId)?.title).toBe("Die Antwort")
  })

  it("keeps a user-renamed title after the first turn", async () => {
    await startMock()
    const uid = seedUser(db, "u")
    // rename BEFORE the first send: the AI path must bail (no LLM call)
    const { renameThread } = await import("@/lib/agent/store")
    renameThread(threadId, "Mein Name")
    await send("Erste Frage")
    await settle()
    expect(getThread(threadId)?.title).toBe("Mein Name")
    expect(requests).toHaveLength(1)
    void uid
  })
})
