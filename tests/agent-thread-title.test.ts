import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Server } from "node:http"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { resetConfigCache } from "@/lib/config"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { seedUser } from "./helpers"
import { sanitizeTitle, maybeAutoTitle } from "@/lib/agent/thread-title"
import { createThread, getThread } from "@/lib/agent/store"

/**
 * AI thread titling (ADR-0033): one-shot completion after the first turn,
 * default-title guard both before the call and on write, sanitize rules,
 * and detached failure swallowing.
 */

let db: Db
let uid: number

let server: Server | null = null
/** Scripted title answers, one per incoming POST. */
let titleAnswers: string[] = []
/** Captured request bodies. */
let requests: Array<Record<string, unknown>> = []

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  uid = seedUser(db, "user-1")
  resetConfigCache()
})
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })
  server = null
  titleAnswers = []
  requests = []
  resetConfigCache()
  vi.restoreAllMocks()
})

function setBaseUrl(url: string) {
  process.env.LLM_BASE_URL = url
  resetConfigCache()
}

/** Mock chat server that answers every POST with one title. */
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
      const answer = titleAnswers[requests.length - 1] ?? ""
      const frames = answer
        ? `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`
        : ""
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(frames + "data: [DONE]\n\n")
      res.end()
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  setBaseUrl(`http://127.0.0.1:${port}`)
}

/** Waits for microtasks/fire-and-forget chains to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
}

describe("sanitizeTitle", () => {
  it("strips quotes and collapses whitespace", () => {
    expect(sanitizeTitle('  "Haushalts\tnfragen" ')).toBe("Haushalts nfragen")
    expect(sanitizeTitle("„Wichtige Ausgaben“")).toBe("Wichtige Ausgaben")
  })

  it("caps at 80 chars", () => {
    const long = sanitizeTitle("x".repeat(200))
    expect(long.length).toBe(80)
  })

  it("rejects empty and placeholder answers", () => {
    expect(sanitizeTitle("   ")).toBe("")
    expect(sanitizeTitle("Neuer Chat")).toBe("")
    expect(sanitizeTitle("Unbenannt")).toBe("")
    expect(sanitizeTitle("Titel")).toBe("")
  })
})

describe("maybeAutoTitle", () => {
  it("replaces the default title with the model suggestion after turn 1", async () => {
    await startServer()
    titleAnswers = ["Kategorie Summen"]
    const thread = createThread(uid, "Neuer Chat")
    maybeAutoTitle(thread.id, "Wie heißen meine Kategorien mit Summen?")
    await settle()
    expect(getThread(thread.id)?.title).toBe("Kategorie Summen")
    // the one-shot prompt carried the user message, no tools advertised
    expect(requests).toHaveLength(1)
    expect(requests[0].tools).toBeUndefined()
    expect(JSON.stringify(requests[0].messages)).toContain("Kategorie")
  })

  it("falls back to the 24-char substring when the model answers unusably", async () => {
    await startServer()
    titleAnswers = ["   "]
    const thread = createThread(uid, "Neuer Chat")
    maybeAutoTitle(
      thread.id,
      "Wie viel habe ich diesen Monat für Shopping ausgegeben?"
    )
    await settle()
    expect(getThread(thread.id)?.title).toBe("Wie viel habe ich diesen…")
  })

  it("never overwrites a user-chosen title", async () => {
    await startServer()
    titleAnswers = ["Kategorie Summen"]
    const thread = createThread(uid, "Mein eigener Titel")
    maybeAutoTitle(thread.id, "irgendwas")
    await settle()
    expect(getThread(thread.id)?.title).toBe("Mein eigener Titel")
    // bailed before the LLM call
    expect(requests).toHaveLength(0)
  })

  it("falls back to the substring title when the LLM fails", async () => {
    // no server: fetch fails with connection refused
    setBaseUrl("http://127.0.0.1:9")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const thread = createThread(uid, "Neuer Chat")
    maybeAutoTitle(thread.id, "Wie viel habe ich für Essen ausgegeben?")
    await settle()
    expect(getThread(thread.id)?.title).toBe("Wie viel habe ich für Es…")
    warn.mockRestore()
  })

  it("a failed fallback also leaves the title untouched when empty", async () => {
    setBaseUrl("http://127.0.0.1:9")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const thread = createThread(uid, "Neuer Chat")
    maybeAutoTitle(thread.id, "   ")
    await settle()
    expect(getThread(thread.id)?.title).toBe("Neuer Chat")
    warn.mockRestore()
  })
})
