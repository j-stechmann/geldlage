import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { Server } from "node:http"
import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { resetConfigCache } from "@/lib/config"
import type { Db } from "@/lib/db"
import { chatMessages, chatThreadMembers, users } from "@/lib/db/schema"
import { GET as listUsers } from "@/app/api/users/route"
import {
  GET as listThreads,
  POST as createThreadRoute,
} from "@/app/api/agent/threads/route"
import {
  PATCH as patchThread,
  DELETE as deleteThreadRoute,
} from "@/app/api/agent/threads/[id]/route"
import {
  GET as listInvites,
  POST as inviteRoute,
} from "@/app/api/agent/threads/[id]/invites/route"
import { DELETE as removeInviteRoute } from "@/app/api/agent/threads/[id]/invites/[userId]/route"
import { POST as joinRoute } from "@/app/api/agent/threads/[id]/join/route"
import { GET as listMessages } from "@/app/api/agent/threads/[id]/messages/route"
import { POST as chatRoute } from "@/app/api/agent/threads/[id]/chat/route"
import {
  appendMessage,
  getThread,
  listMembers,
  renameThread,
  roleOf,
} from "@/lib/agent/store"
import {
  AGENT_NO_ANSWER_TEXT,
  INVITE_MAX_USER_IDS,
} from "@/lib/agent/constants"
import { setupTestDb, seedUser, authedRequest } from "./helpers"

/**
 * Access-matrix tests for the agent thread API (ADR-0033): owner / joined
 * member / invited / outsider per endpoint. Route handlers run directly
 * (signed session cookie per user, mirroring prod session resolution).
 */

let db: Db
let u1: number
let u2: number
let u3: number
let threadId: string

function url(path: string): string {
  return `https://app.example.com${path}`
}

/**
 * Note: these requests intentionally carry NO Origin/Sec-Fetch-Site headers
 * — assertSameOrigin allows header-less requests (legacy-browser allowance,
 * see lib/auth/guard.ts), so mutating routes are exercised without CSRF
 * metadata everywhere here. The guard's own accept/reject matrix lives in
 * tests/auth-csrf-guard.test.ts.
 */
async function req(
  path: string,
  uid: number,
  init: { method?: string; body?: unknown } = {}
) {
  return authedRequest(url(path), uid, {
    method: init.method ?? "GET",
    body: init.body,
  })
}

async function asJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

beforeEach(async () => {
  ;({ db, userId: u1 } = setupTestDb())
  u2 = seedUser(db, "user-2")
  u3 = seedUser(db, "user-3")
  const res = await createThreadRoute(
    await req("/api/agent/threads", u1, { method: "POST", body: {} })
  )
  const { thread } = (await asJson(res)) as { thread: { id: string } }
  threadId = thread.id
})

describe("POST /api/agent/threads", () => {
  it("creates a thread with the default title", async () => {
    const res = await createThreadRoute(
      await req("/api/agent/threads", u2, { method: "POST", body: {} })
    )
    expect(res.status).toBe(201)
    const { thread } = await asJson(res)
    expect((thread as { title: string }).title).toBe("Neuer Chat")
    expect(roleOf((thread as { id: string }).id, u2)).toBe("owner")
    expect(roleOf((thread as { id: string }).id, u1)).toBeNull()
  })

  it("rejects the unauthenticated POST", async () => {
    // bare Request without a session cookie (the CSRF guard's matrix is
    // covered separately in tests/auth-csrf-guard.test.ts)
    const res = await createThreadRoute(
      new (await import("next/server")).NextRequest(
        new Request(url("/api/agent/threads"), { method: "POST" })
      )
    )
    // no session → 401 (guard order: session before CSRF)
    expect([401, 403]).toContain(res.status)
  })

  it("401s (not a 500) when the cookie outlives the users row (dangling uid)", async () => {
    // ADR-0032 fresh-start wipe: the stateless JWT still verifies while
    // the users row is gone — createThread would die on the
    // chat_threads→users FK (unhandled 500). The 401 bounces apiFetch
    // into a fresh OIDC round-trip, which re-provisions the user.
    const gone = u3 + 1000 // signed cookie for a uid with no users row
    const created = await createThreadRoute(
      await req("/api/agent/threads", gone, { method: "POST", body: {} })
    )
    expect(created.status).toBe(401)
    // the same guard covers the list route (requireSessionGate is
    // shared by every agent route)
    const listed = await listThreads(await req("/api/agent/threads", gone))
    expect(listed.status).toBe(401)
  })
})

describe("GET /api/agent/threads", () => {
  it("lists owned threads with role owner", async () => {
    const res = await listThreads(await req("/api/agent/threads", u1))
    const { threads } = (await asJson(res)) as {
      threads: Array<{ id: string; role: string; title: string }>
    }
    expect(threads.some((t) => t.id === threadId && t.role === "owner")).toBe(
      true
    )
  })

  it("shows joined/invited threads with the matching role", async () => {
    await inviteRoute(
      await req(`/api/agent/threads/${threadId}/invites`, u1, {
        method: "POST",
        body: { userIds: [u2, u3] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    const before = (await asJson(
      await listThreads(await req("/api/agent/threads", u2))
    )) as { threads: Array<{ id: string; role: string }> }
    expect(before.threads.find((t) => t.id === threadId)?.role).toBe("invited")

    await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, u2, { method: "POST" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    const after = (await asJson(
      await listThreads(await req("/api/agent/threads", u2))
    )) as { threads: Array<{ id: string; role: string }> }
    expect(after.threads.find((t) => t.id === threadId)?.role).toBe("member")
  })
})

describe("PATCH /api/agent/threads/[id]", () => {
  it("renames for the owner and rejects invalid titles", async () => {
    const ok = await patchThread(
      await req(`/api/agent/threads/${threadId}`, u1, {
        method: "PATCH",
        body: { title: "Budget" },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(ok.status).toBe(200)
    expect(roleOf(threadId, u1)).toBe("owner")

    const empty = await patchThread(
      await req(`/api/agent/threads/${threadId}`, u1, {
        method: "PATCH",
        body: { title: "  " },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(empty.status).toBe(400)
  })

  it("404s for members and outsiders (no existence leak)", async () => {
    for (const uid of [u2, u3]) {
      const res = await patchThread(
        await req(`/api/agent/threads/${threadId}`, uid, {
          method: "PATCH",
          body: { title: "X" },
        }),
        { params: Promise.resolve({ id: threadId }) }
      )
      expect(res.status).toBe(404)
    }
  })
})

describe("invites", () => {
  it("invites dedupe and skip the owner", async () => {
    const route = `/api/agent/threads/${threadId}/invites`
    const first = await inviteRoute(
      await req(route, u1, {
        method: "POST",
        body: { userIds: [u2, u2, u1] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect((await asJson(first)).invited).toBe(1)

    const second = await inviteRoute(
      await req(route, u1, {
        method: "POST",
        body: { userIds: [u2] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect((await asJson(second)).invited).toBe(0)
  })

  it("rejects oversized batches (400, not a 500 from SQLite's variable limit)", async () => {
    const res = await inviteRoute(
      await req(`/api/agent/threads/${threadId}/invites`, u1, {
        method: "POST",
        body: {
          userIds: Array.from(
            { length: INVITE_MAX_USER_IDS + 1 },
            (_, i) => i + 1
          ),
        },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(res.status).toBe(400)
    expect(((await asJson(res)) as { error: string }).error).toBe(
      "invalid_user_ids"
    )
  })

  it("member-lists with owner synthesized; owner-only", async () => {
    const foreign = await listInvites(
      await req(`/api/agent/threads/${threadId}/invites`, u2),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(foreign.status).toBe(404)

    await inviteRoute(
      await req(`/api/agent/threads/${threadId}/invites`, u1, {
        method: "POST",
        body: { userIds: [u2] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    const mine = (await asJson(
      await listInvites(
        await req(`/api/agent/threads/${threadId}/invites`, u1),
        { params: Promise.resolve({ id: threadId }) }
      )
    )) as { members: Array<{ userId: number; state: string }> }
    expect(mine.members).toHaveLength(2)
    expect(mine.members.find((m) => m.userId === u1)?.state).toBe("owner")
    expect(mine.members.find((m) => m.userId === u2)?.state).toBe("invited")
  })

  it("owner removes a member; never themself", async () => {
    await inviteRoute(
      await req(`/api/agent/threads/${threadId}/invites`, u1, {
        method: "POST",
        body: { userIds: [u2] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    const selfRemove = await removeInviteRoute(
      await req(`/api/agent/threads/${threadId}/invites/${u1}`, u1, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: threadId, userId: String(u1) }) }
    )
    expect(selfRemove.status).toBe(400)

    const foreign = await removeInviteRoute(
      await req(`/api/agent/threads/${threadId}/invites/${u2}`, u3, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: threadId, userId: String(u2) }) }
    )
    expect(foreign.status).toBe(404)

    const ok = await removeInviteRoute(
      await req(`/api/agent/threads/${threadId}/invites/${u2}`, u1, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: threadId, userId: String(u2) }) }
    )
    expect((await asJson(ok)).removed).toBe(true)
    expect(listMembers(threadId).filter((m) => m.userId === u2)).toHaveLength(0)
  })
})

describe("join + message visibility", () => {
  beforeEach(async () => {
    await inviteRoute(
      await req(`/api/agent/threads/${threadId}/invites`, u1, {
        method: "POST",
        body: { userIds: [u2, u3] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
  })

  it("invited users cannot read messages (preview after join)", async () => {
    const res = await listMessages(
      await req(`/api/agent/threads/${threadId}/messages`, u2),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(res.status).toBe(404)
  })

  it("join upgrades invited → joined and unlocks reading", async () => {
    const ok = await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, u2, { method: "POST" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect((await asJson(ok)).joined).toBe(true)
    const res = (await asJson(
      await listMessages(
        await req(`/api/agent/threads/${threadId}/messages`, u2),
        { params: Promise.resolve({ id: threadId }) }
      )
    )) as { role: string; members: Array<{ userId: number; state: string }> }
    expect(res.role).toBe("member")
    expect(res.members.find((m) => m.userId === u2)?.state).toBe("joined")
  })

  it("join without any invite is 404", async () => {
    const fresh = seedUser(db, "user-4")
    const res = await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, fresh, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(res.status).toBe(404)
  })

  it("join for the owner is an idempotent no-op 200", async () => {
    // owner joining own thread: the gate's roleOf returns "owner" and the
    // route short-circuits before any member-store write — deterministic
    // 200; pinned so a guard regression that downgrades the role to 404
    // cannot slip through.
    const res = await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, u1, { method: "POST" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(res.status).toBe(200)
    // but an invited→joined flow stays correct
    await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, u2, { method: "POST" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(roleOf(threadId, u2)).toBe("member")
  })
})

describe("chat route gating", () => {
  it("404s for outsiders and invited users, 400 for empty content", async () => {
    const byInvited = await chatRoute(
      await req(`/api/agent/threads/${threadId}/chat`, u2, {
        method: "POST",
        body: { content: "hi" },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(byInvited.status).toBe(404) // invited-but-not-joined

    await inviteRoute(
      await req(`/api/agent/threads/${threadId}/invites`, u1, {
        method: "POST",
        body: { userIds: [u2, u3] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, u2, { method: "POST" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    const empty = await chatRoute(
      await req(`/api/agent/threads/${threadId}/chat`, u2, {
        method: "POST",
        body: { content: "   " },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(empty.status).toBe(400)

    const outsider = await chatRoute(
      await req(`/api/agent/threads/${threadId}/chat`, u3, {
        method: "POST",
        body: { content: "hi" },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(outsider.status).toBe(404)
  })
})

describe("chat route turn persistence", () => {
  let server: Server | null = null
  let agentRequests = 0
  /**
   * Scripted tool-call rounds for AGENT (non-title) LLM requests, one
   * entry per loop round; the auto-title one-shot is answered separately
   * by its "Chat-Titel" prompt marker.
   */
  let scripted: Array<{
    toolCalls?: Array<{
      index: number
      id: string
      name: string
      arguments: string
    }>
    content?: string[]
    reasoning?: string[]
  }> = []
  /** Captured (non-title) request bodies, in arrival order. */
  let captured: Array<{
    messages: Array<{
      role: string
      content?: unknown
      tool_calls?: Array<{ id?: string }>
      tool_call_id?: string
    }>
  }> = []

  beforeEach(() => {
    agentRequests = 0
    scripted = []
    captured = []
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = null
    resetConfigCache()
  })

  /** Lets the fire-and-forget auto-title one-shot land before teardown. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 10))
  }

  /** Mock llama-server: scripted agent rounds, fixed answer for titles. */
  async function startLlmMock(): Promise<void> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{
            role: string
            content?: unknown
            tool_calls?: Array<{ id?: string }>
            tool_call_id?: string
          }>
        }
        const isTitleCall = body.messages.some(
          (m) =>
            typeof m.content === "string" && m.content.includes("Chat-Titel")
        )
        if (!isTitleCall) captured.push(body)
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        const frames: string[] = []
        if (isTitleCall) {
          frames.push(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "Titel" } }],
            })}`
          )
        } else {
          const round = scripted[agentRequests++] ?? { content: ["fehler"] }
          for (const c of round.toolCalls ?? []) {
            frames.push(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: c.index,
                          id: c.id,
                          function: { name: c.name, arguments: c.arguments },
                        },
                      ],
                    },
                  },
                ],
              })}`
            )
          }
          for (const r of round.reasoning ?? []) {
            frames.push(
              `data: ${JSON.stringify({
                choices: [{ delta: { reasoning_content: r } }],
              })}`
            )
          }
          for (const text of round.content ?? []) {
            frames.push(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: text } }],
              })}`
            )
          }
        }
        frames.push("data: [DONE]")
        res.write(frames.map((f) => f + "\n\n").join(""))
        res.end()
      })
    })
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve)
    )
    const port = (server!.address() as AddressInfo).port
    process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`
    resetConfigCache()
  }

  /** Runs one chat turn to completion; resolves with the raw SSE text. */
  async function postChat(content: string): Promise<string> {
    const res = await chatRoute(
      await req(`/api/agent/threads/${threadId}/chat`, u1, {
        method: "POST",
        body: { content },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
    return res.text()
  }

  function rowsInSeq(): Array<{
    id: string
    role: string
    userId: number | null
    content: string
    reasoning: string | null
    toolName: string | null
    toolArgs: string | null
    toolCalls: string | null
    toolCallId: string | null
    threadSeq: number
  }> {
    return (
      db
        .select()
        .from(chatMessages)
        .all()
        // fresh per-test db → exactly this thread's rows, seq order pinned
        .sort((a, b) => a.threadSeq - b.threadSeq)
    )
  }

  it("persists one assistant row per round + paired tool rows (replayable transcript)", async () => {
    await startLlmMock()
    scripted = [
      {
        toolCalls: [
          {
            index: 0,
            id: "call_1",
            name: "get_category_totals",
            arguments: '{"period":"this_month"}',
          },
        ],
      },
      { content: ["Hier sind deine Summen."] },
    ]

    const text = await postChat("Summen?")
    await settle()
    const rows = rowsInSeq()
    // Claude Code-style transcript: the round-1 assistant row precedes
    // its tool rows (threadSeq = streamed event order), the final round
    // appends its own row.
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ])

    const [round1, toolRow, final] = rows.filter((r) => r.role !== "user")
    // round 1 streamed no prose: empty content + the wire tool_calls
    expect(round1.content).toBe("")
    const calls = JSON.parse(round1.toolCalls ?? "[]") as Array<{
      id: string
      type: string
      function: { name: string; arguments: string }
    }>
    expect(calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "get_category_totals",
          arguments: '{"period":"this_month"}',
        },
      },
    ])

    expect(toolRow.userId).toBeNull()
    expect(toolRow.toolName).toBe("get_category_totals")
    expect(toolRow.toolArgs).toBe('{"period":"this_month"}')
    // the tool row pairs to its round via the wire id
    expect(toolRow.toolCallId).toBe("call_1")
    // the tool row carries the EXECUTED result (real tool run, uid-scoped)
    const parsed = JSON.parse(toolRow.content) as { categories?: unknown }
    expect(parsed.categories).toEqual([])

    expect(final.content).toBe("Hier sind deine Summen.")

    // done frame's messageId = the LAST assistant row id (client alignment)
    const doneFrames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: done"))
    expect(doneFrames).toHaveLength(1)
    const dataLine = doneFrames[0]
      .split("\n")
      .find((line) => line.startsWith("data: "))
    const done = JSON.parse(dataLine!.replace(/^data: /, "")) as {
      messageId: string
    }
    expect(done.messageId).toBe(final.id)
  })

  it("replays the prior turn's protocol trio into the follow-up request", async () => {
    await startLlmMock()
    scripted = [
      {
        toolCalls: [
          {
            index: 0,
            id: "call_1",
            name: "get_category_totals",
            arguments: '{"period":"this_month"}',
          },
        ],
      },
      { content: ["Hier sind deine Summen."] },
      { content: ["ok"] },
    ]

    await postChat("Summen?")
    await postChat("Und jetzt?")
    await settle()

    // The turn-2 request (found by its trailing user message — the
    // fire-and-forget title one-shot interleaves nondeterministically)
    // must replay turn 1's rows as the exact protocol messages: user,
    // assistant+tool_calls, tool, assistant.
    const turn2 = captured.find(
      (c) => c.messages[c.messages.length - 1]?.content === "Und jetzt?"
    )
    expect(turn2).toBeDefined()
    const roles = turn2!.messages.map((m) => m.role)
    expect(roles[0]).toBe("system")
    expect(roles.slice(1)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ])
    const assistantCall = turn2!.messages.find((m) =>
      Array.isArray(m.tool_calls)
    )
    expect(assistantCall?.tool_calls?.[0].id).toBe("call_1")
    const toolMsg = turn2!.messages.find((m) => m.role === "tool")
    expect(toolMsg?.tool_call_id).toBe("call_1")
    expect(String(toolMsg?.content)).toContain('"categories"')
  })

  it("replays legacy rows as plain text (tool rows dropped, no backfill)", async () => {
    await startLlmMock()
    // Old-shape transcript: one merged assistant row + tool rows without
    // pairing ids (the pre-amendment persister's output).
    appendMessage(threadId, {
      userId: u1,
      role: "user",
      content: "Alt?",
    })
    appendMessage(threadId, {
      userId: null,
      role: "tool",
      content: '{"legacy":true}',
      toolName: "get_category_totals",
      toolArgs: "{}",
    })
    appendMessage(threadId, {
      userId: null,
      role: "assistant",
      content: "Alte Antwort.",
    })
    scripted = [{ content: ["ok"] }]

    await postChat("Neu?")
    await settle()
    const turn2 = captured.find(
      (c) => c.messages[c.messages.length - 1]?.content === "Neu?"
    )
    expect(turn2).toBeDefined()
    const roles = turn2!.messages.map((m) => m.role)
    expect(roles).toEqual(["system", "user", "assistant", "user"])
    expect(turn2!.messages.some((m) => m.role === "tool")).toBe(false)
  })

  it("persists no assistant row for an empty answer while keeping the user row", async () => {
    await startLlmMock()
    // empty answer on the tools-allowed round → one tools-free retry, also
    // empty → the turn ends with only the user row persisted
    scripted = [{ content: [] }, { content: [] }]

    await postChat("Still?")
    await settle()
    const rows = rowsInSeq()
    // user row only — no tool rounds ran and an empty answer saves nothing
    expect(rows.map((r) => r.role)).toEqual(["user"])
  })

  it("persists no placeholder row for a reasoning-only round that retries", async () => {
    await startLlmMock()
    // Regression: a tools-allowed round streaming ONLY a thinking trace
    // takes the empty-answer retry. The round is not fully empty, so
    // only the retry flag keeps the AGENT_NO_ANSWER_TEXT placeholder row
    // out of the transcript — otherwise the fake answer would render
    // permanently and rowsToPromptHistory would replay it into every
    // later prompt; only the retry's real answer row persists.
    scripted = [{ reasoning: ["Nachdenken…"] }, { content: ["Eins"] }]

    const text = await postChat("Still?")
    await settle()
    const rows = rowsInSeq()
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"])
    const assistant = rows.find((r) => r.role === "assistant")!
    expect(assistant.content).toBe("Eins")
    // the degenerate round's reasoning must not leak into the answer row
    expect(assistant.reasoning).toBeNull()
    expect(rows.some((r) => r.content === AGENT_NO_ANSWER_TEXT)).toBe(false)

    // the round frames carry the retry flag so the client can discard
    // the degenerate segment (no persisted row behind it): degenerate
    // first, real answer second
    const roundPayloads = text
      .split("\n\n")
      .filter((f) => f.startsWith("event: round"))
      .map((f) => {
        const dataLine = f.split("\n").find((l) => l.startsWith("data: "))
        return JSON.parse(dataLine!.replace(/^data: /, "")) as {
          retry: boolean
        }
      })
    expect(roundPayloads.map((p) => p.retry)).toEqual([true, false])
  })
})

describe("DELETE /api/agent/threads/[id] (leave/decline/delete)", () => {
  beforeEach(async () => {
    await inviteRoute(
      await req(`/api/agent/threads/${threadId}/invites`, u1, {
        method: "POST",
        body: { userIds: [u2] },
      }),
      { params: Promise.resolve({ id: threadId }) }
    )
  })

  it("invited user declines: member row gone, thread intact", async () => {
    const res = await deleteThreadRoute(
      await req(`/api/agent/threads/${threadId}`, u2, { method: "DELETE" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect((await asJson(res)).left).toBe(true)
    expect(getThread(threadId)).toBeDefined()
    expect(roleOf(threadId, u2)).toBeNull()
  })

  it("joined member leaves; thread survives for the owner", async () => {
    await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, u2, { method: "POST" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    appendMessage(threadId, { userId: u1, role: "user", content: "hallo" })
    const res = await deleteThreadRoute(
      await req(`/api/agent/threads/${threadId}`, u2, { method: "DELETE" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect((await asJson(res)).left).toBe(true)
    expect(roleOf(threadId, u2)).toBeNull()
    expect(getThread(threadId)).toBeDefined()
    expect(roleOf(threadId, u1)).toBe("owner")
  })

  it("outsider DELETE is 404", async () => {
    const res = await deleteThreadRoute(
      await req(`/api/agent/threads/${threadId}`, u3, { method: "DELETE" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect(res.status).toBe(404)
  })

  it("owner delete cascades members + messages", async () => {
    await joinRoute(
      await req(`/api/agent/threads/${threadId}/join`, u2, { method: "POST" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    appendMessage(threadId, { userId: u1, role: "user", content: "hallo" })
    const res = await deleteThreadRoute(
      await req(`/api/agent/threads/${threadId}`, u1, { method: "DELETE" }),
      { params: Promise.resolve({ id: threadId }) }
    )
    expect((await asJson(res)).deleted).toBe(true)
    expect(getThread(threadId)).toBeUndefined()
    expect(db.select().from(chatThreadMembers).all()).toHaveLength(0)
    expect(db.select().from(chatMessages).all()).toHaveLength(0)
  })
})

describe("title guard", () => {
  it("renamed threads keep their title through later messages", () => {
    // user renames via PATCH first, then sends messages — the auto-title
    // paths (AI + fallback) in lib/agent/thread-title.ts only ever write
    // over the default title ("Neuer Chat"), enforced by their own guard;
    // here the store-side invariant: plain appends never touch the title.
    renameThread(threadId, "Budget")
    appendMessage(threadId, {
      userId: u1,
      role: "user",
      content: "erste Frage nach dem Umbenennen",
    })
    expect(getThread(threadId)?.title).toBe("Budget")
  })

  it("a fresh thread keeps the default title until a turn completes", () => {
    // titling (AI or fallback) runs post-turn via maybeAutoTitle — covered
    // in tests/agent-thread-title.test.ts
    expect(getThread(threadId)?.title).toBe("Neuer Chat")
    appendMessage(threadId, { userId: u1, role: "user", content: "nochwas" })
    expect(getThread(threadId)?.title).toBe("Neuer Chat")
  })
})

describe("GET /api/users", () => {
  it("lists all users except the requester with name/email only", async () => {
    const res = (await asJson(
      await listUsers(await req("/api/users", u1))
    )) as { users: Array<{ id: number; name: string; email: string }> }
    const ids = res.users.map((u) => u.id)
    expect(ids).not.toContain(u1)
    expect(ids).toContain(u2)
    expect(ids).toContain(u3)
    expect(Object.keys(res.users[0]).sort()).toEqual(["email", "id", "name"])
  })

  it("works for every authenticated user", async () => {
    const res = await listUsers(await req("/api/users", u3))
    expect(res.status).toBe(200)
  })

  it("rejects the unauthenticated", async () => {
    const { NextRequest } = await import("next/server")
    const res = await listUsers(new NextRequest(new Request(url("/api/users"))))
    expect(res.status).toBe(401)
  })
})

describe("user rows integrity", () => {
  it("seeded users exist with expected emails", () => {
    const all = db.select().from(users).all()
    expect(all.map((u) => u.email)).toContain("user-2@example.com")
    expect(all.filter((u) => u.email === "user-1@example.com")).toHaveLength(1)
  })
})
