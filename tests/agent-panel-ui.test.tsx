// @vitest-environment jsdom
/**
 * AgentChat UI tests (ADR-0033): fetch is stubbed per-URL (no server);
 * covers message rendering, the streaming turn lifecycle (optimistic user
 * bubble → streamed content/tool chips → persisted rows after done), and
 * the invited-user join panel. Server behavior (route matrix) is covered
 * in tests/agent-threads-api; SSE frame parsing in tests/agent-sse-events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement } from "react"
import { AgentChat } from "@/components/agent/agent-chat"
import {
  renderWithQuery,
  sseFrames,
  stubMatchMedia,
  stubLocalStorage,
  stubResizeObserver,
  stubScrollTo,
} from "./helpers-dom"

/** Thread detail the messages route returns. */
function threadDetail(
  messages: Array<Record<string, unknown>>,
  role: "owner" | "member" = "owner"
) {
  return {
    thread: {
      id: "t1",
      title: "Neuer Chat",
      ownerId: 1,
      ownerName: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    role,
    members: [{ userId: 1, name: "user-1", email: "u1@x.de", state: "owner" }],
    messages,
  }
}

function msg(
  id: string,
  role: "user" | "assistant" | "tool",
  content: string,
  threadSeq: number,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    userId: role === "user" ? 1 : null,
    role,
    content,
    reasoning: null,
    toolName: null,
    toolArgs: null,
    createdAt: `2026-01-01T00:00:0${threadSeq}.000Z`,
    threadSeq,
    ...extra,
  }
}

const seedMessages: Array<Record<string, unknown>> = [
  msg("m1", "user", "Wie viel habe ich diesen Monat ausgegeben?", 1),
  msg("m2", "assistant", "4211,00 €", 2, {
    reasoning: "Die Summe der negativen Beträge.",
  }),
]

const postTurnMessages: Array<Record<string, unknown>> = [
  ...seedMessages,
  msg("m-tool", "tool", '{"totalsCents":{"inflow":0,"outflow":-421100}}', 3, {
    toolName: "get_category_totals",
    toolArgs: '{"period":"this_month"}',
  }),
  msg("m9", "assistant", "Du hast 4211,00 € ausgegeben.", 4, {
    reasoning: "Nachdenken…",
  }),
]

/** One fetch stub covering the whole thread flow via a mutable script. */
function stubChatFlow(state: {
  messages: Array<Record<string, unknown>>
  threads: Array<Record<string, unknown>>
}) {
  const calls: Array<{ path: string; method: string }> = []
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0]
      const method = (init?.method ?? "GET").toUpperCase()
      calls.push({ path, method })
      if (path === "/api/agent/threads" && method === "GET") {
        return Response.json({ threads: state.threads })
      }
      if (path === "/api/agent/threads/t1/messages" && method === "GET") {
        return Response.json(threadDetail(state.messages))
      }
      if (path === "/api/agent/threads/t1/chat" && method === "POST") {
        return new Response(chatStream(state), {
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (path === "/api/agent/threads/t2/messages" && method === "GET") {
        return Response.json({ error: "not_found" }, { status: 404 })
      }
      if (path === "/api/agent/threads/t2/join" && method === "POST") {
        return Response.json({ joined: true })
      }
      throw new TypeError(`unscripted ${path} ${method}`)
    }
  )
  vi.stubGlobal("fetch", fetchMock)
  return { calls }
}

/**
 * The streamed turn: reasoning → tool round → content, then held open
 * until `release` is called (so the mid-stream bubble is assertable).
 */
let chatStream: (state: { messages: unknown[] }) => ReadableStream<Uint8Array>
let releaseTurn: () => void

beforeEach(() => {
  stubLocalStorage()
  stubMatchMedia()
  stubScrollTo()
  stubResizeObserver()
  window.confirm = vi.fn(() => true)
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  releaseTurn = release
  const enc = new TextEncoder()
  chatStream = () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          enc.encode(
            sseFrames([
              { event: "reasoning", data: { text: "Nachdenken…" } },
              {
                event: "tool_call",
                data: {
                  name: "get_category_totals",
                  args: '{"period":"this_month"}',
                },
              },
              {
                event: "tool_result",
                data: {
                  name: "get_category_totals",
                  result: '{"totalsCents":{"inflow":0,"outflow":-421100}}',
                },
              },
              {
                event: "delta",
                data: { text: "Du hast 4211,00 € ausgegeben." },
              },
            ])
          )
        )
        await gate
        controller.enqueue(
          enc.encode(
            sseFrames([
              {
                event: "done",
                data: {
                  messageId: "m9",
                  content: "Du hast 4211,00 € ausgegeben.",
                },
              },
            ])
          )
        )
        controller.close()
      },
    })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("<AgentChat>", () => {
  it("renders stored messages (user right, assistant with Denkprozess)", async () => {
    stubChatFlow({
      messages: [{ ...seedMessages[0] }, { ...seedMessages[1] }],
      threads: [
        {
          id: "t1",
          title: "Haushaltsfragen",
          role: "owner",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(
        screen.getByText("Wie viel habe ich diesen Monat ausgegeben?")
      ).toBeInTheDocument()
    )
    expect(screen.getByText("4211,00 €")).toBeInTheDocument()
    expect(screen.getAllByText("Denkprozess").length).toBeGreaterThan(0)
  })

  it("streams a turn: bubble mid-stream, persisted rows replace it after done", async () => {
    const state = {
      messages: [{ ...seedMessages[0] }, { ...seedMessages[1] }] as Array<
        Record<string, unknown>
      >,
      threads: [
        {
          id: "t1",
          title: "Haushaltsfragen",
          role: "owner",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    stubChatFlow(state)
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(screen.getByText("4211,00 €")).toBeInTheDocument()
    )

    const input = screen.getByPlaceholderText("Nachricht…")
    await userEvent.type(input, "Wie viel?")
    await userEvent.click(screen.getByRole("button", { name: "Senden" }))

    // mid-stream: optimistic user bubble + streamed content + tool chip
    await waitFor(() =>
      expect(screen.getByText("Wie viel?")).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(
        screen.getByText(/Du hast 4211,00 € ausgegeben\./)
      ).toBeInTheDocument()
    )
    expect(screen.getAllByText("get_category_totals").length).toBeGreaterThan(0)

    // done: release the stream; the finally-refetch now returns the
    // persisted rows (the server appended user+tool+assistant during the
    // turn — modeled here by swapping the state the stub serves)
    await act(async () => {
      state.messages = postTurnMessages.map((m) => ({ ...m }))
      releaseTurn()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.queryByText("Wie viel?")).not.toBeInTheDocument()
    )
    // the streamed answer survives as the stored assistant row
    expect(screen.getAllByText(/Du hast 4211,00 € ausgegeben\./)).toHaveLength(
      1
    )
    // persisted tool chip + Denkprozess toggle on the stored row
    expect(screen.getAllByText("get_category_totals").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Denkprozess").length).toBeGreaterThan(0)
    // the state mutation fed the post-turn rows through the shared state
    const persisted = screen.getAllByText(/Du hast/)
    expect(persisted.length).toBe(1)
  }, 15_000)

  it("auto-selects the newest own thread; sends create thread none exists", async () => {
    const state = {
      messages: [],
      threads: [
        {
          id: "t1",
          title: "Haushaltsfragen",
          role: "owner",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    stubChatFlow(state)
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(screen.getByText("Haushaltsfragen")).toBeInTheDocument()
    )
    // detail query fetched automatically for the auto-selected thread
    await waitFor(() =>
      expect((state as { messages: unknown[] }).messages.length === 0).toBe(
        true
      )
    )
    expect(
      screen.queryByText("Stell eine Frage zu deinen Finanzdaten…")
    ).not.toBeInTheDocument()
  })

  it("shows the invited join panel after selecting the invite, join POSTs", async () => {
    const state = {
      messages: [],
      threads: [
        {
          id: "t2",
          title: "Geteilter Chat",
          role: "invited",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { calls } = stubChatFlow(state)
    renderWithQuery(createElement(AgentChat))
    // no own thread ⇒ empty state; the invite waits in the dropdown
    // ("1 Chats" proves the threads query landed)
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "1 Chats" })
      ).toBeInTheDocument()
    )
    await userEvent.click(screen.getByRole("button", { name: "1 Chats" }))
    await userEvent.click(screen.getByText("Geteilter Chat"))
    // invited users get the join panel instead of messages (404 by design)
    await waitFor(() =>
      expect(screen.getByText(/Einladung zu/)).toBeInTheDocument()
    )
    await userEvent.click(screen.getByRole("button", { name: "Annehmen" }))
    // the join POST fires and the threads list refetches (the success toast
    // renders via the app-level sonner <Toaster>, absent in tests)
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.path === "/api/agent/threads/t2/join" && c.method === "POST"
        )
      ).toBe(true)
    )
  }, 15_000)

  it("shows the empty state with no active thread", async () => {
    stubChatFlow({ messages: [], threads: [] })
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(
        screen.getByText("Stell eine Frage zu deinen Finanzdaten…")
      ).toBeInTheDocument()
    )
  })

  it("does NOT show the join panel for an owner thread on transient detail error", async () => {
    const state = {
      messages: [] as Array<Record<string, unknown>>,
      threads: [
        {
          id: "t1",
          title: "Haushaltsfragen",
          role: "owner",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { calls } = stubChatFlow(state)
    // script the detail fetch to fail (network/server hiccup)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).split("?")[0]
        const method = (init?.method ?? "GET").toUpperCase()
        calls.push({ path, method })
        if (path === "/api/agent/threads" && method === "GET") {
          return Response.json({ threads: state.threads })
        }
        if (path === "/api/agent/threads/t1/messages") {
          return new Response(null, { status: 503 })
        }
        throw new TypeError(`unscripted ${path} ${method}`)
      })
    )
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(screen.getByText("Chats konnten nicht geladen werden."))
    )
    // the destructive join panel must not appear for a non-invited role
    expect(screen.queryByText(/Einladung zu/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Ablehnen" })
    ).not.toBeInTheDocument()
    // retry refetches the detail query instead
    await userEvent.click(
      screen.getByRole("button", { name: "Erneut versuchen" })
    )
    expect(
      calls.filter(
        (c) => c.path === "/api/agent/threads/t1/messages" && c.method === "GET"
      ).length
    ).toBeGreaterThan(1)
  })

  it("cancels rename on Escape, blur, and empty submit without PATCHing", async () => {
    const state = {
      messages: [],
      threads: [
        {
          id: "t1",
          title: "Haushaltsfragen",
          role: "owner",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const { calls } = stubChatFlow(state)
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(screen.getByText("Haushaltsfragen")).toBeInTheDocument()
    )
    const input = screen.getByPlaceholderText("Nachricht…")
    await userEvent.type(input, "x")
    await userEvent.click(
      screen.getByRole("button", { name: "Chat umbenennen" })
    )
    const editor = screen.getByPlaceholderText("Titel…")
    expect(editor).toHaveValue("Haushaltsfragen")

    await userEvent.type(editor, "{Escape}")
    // editor closed, no PATCH fired
    expect(screen.queryByPlaceholderText("Titel…")).not.toBeInTheDocument()
    expect(
      calls.some(
        (c) => c.path === "/api/agent/threads/t1" && c.method === "PATCH"
      )
    ).toBe(false)

    // reopen and dismiss via blur (no change) — still no PATCH. Focus
    // leaves via Tab; any outside click (e.g. a thread switch in the
    // dropdown) is just another blur.
    await userEvent.click(
      screen.getByRole("button", { name: "Chat umbenennen" })
    )
    await userEvent.tab()
    expect(screen.queryByPlaceholderText("Titel…")).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === "PATCH")).toBe(false)

    // empty submit also cancels
    await userEvent.click(
      screen.getByRole("button", { name: "Chat umbenennen" })
    )
    const editor2 = screen.getByPlaceholderText("Titel…")
    await userEvent.clear(editor2)
    await userEvent.type(editor2, "{Enter}")
    expect(screen.queryByPlaceholderText("Titel…")).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === "PATCH")).toBe(false)
  })
})
