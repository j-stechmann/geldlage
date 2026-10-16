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
import { toast } from "sonner"
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

/**
 * Post-turn persisted rows in the Claude Code-style transcript shape:
 * the round-1 assistant row (empty prose, its wire tool_calls), its
 * paired tool row, then the final round's row.
 */
const postTurnMessages: Array<Record<string, unknown>> = [
  ...seedMessages,
  msg("m-r1", "assistant", "", 3, {
    reasoning: "Nachdenken…",
    toolCalls: JSON.stringify([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "get_category_totals",
          arguments: '{"period":"this_month"}',
        },
      },
    ]),
  }),
  msg("m-tool", "tool", '{"totalsCents":{"inflow":0,"outflow":-421100}}', 4, {
    toolName: "get_category_totals",
    toolArgs: '{"period":"this_month"}',
    toolCallId: "call_1",
  }),
  msg("m9", "assistant", "Du hast 4211,00 € ausgegeben.", 5),
]

/**
 * The persisted user row the turn appended, as the raced detail fetch
 * serves it: the `user` frame's echoed id (see chatStream) matches the
 * optimistic bubble for identity-based dedupe.
 */
function postTurnMessagesWithUser(): Array<Record<string, unknown>> {
  return [
    ...postTurnMessages.filter((m) => m.id !== "m-tool"),
    { ...msg("m-user", "user", "Wie viel?", 6), id: "m-pending" },
  ]
}

/** One fetch stub covering the whole thread flow via a mutable script. */
function stubChatFlow(state: {
  messages: Array<Record<string, unknown>>
  /** Optional messages for t2 (otherwise t2 serves the 404 preview). */
  messagesT2?: Array<Record<string, unknown>>
  /** Makes the chat POST answer this plain JSON error before persisting. */
  chatReject?: { status: number; body: Record<string, unknown> }
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
        if (state.chatReject) {
          return Response.json(state.chatReject.body, {
            status: state.chatReject.status,
          })
        }
        return new Response(chatStream(state), {
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (path === "/api/agent/threads/t2/messages" && method === "GET") {
        if (!state.messagesT2) {
          return Response.json({ error: "not_found" }, { status: 404 })
        }
        return Response.json(threadDetail(state.messagesT2))
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
 * The streamed turn: reasoning → round boundary → tool round → content,
 * held open until `release` is called (so the mid-stream bubbles are
 * assertable). Claude Code-style frames: the first `round` freezes the
 * prose-less tool round, the trailing one freezes the final answer.
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
              { event: "user", data: { id: "m-pending" } },
              { event: "reasoning", data: { text: "Nachdenken…" } },
              { event: "round", data: {} },
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
              { event: "round", data: {} },
              { event: "done", data: { messageId: "m9" } },
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
    // turn — modeled here by swapping the state the stub serves). The
    // persisted user row carries the id the `user` frame echoed, so the
    // optimistic bubble retires by identity.
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

  it("renders one bubble per round, chips attached to the calling round", async () => {
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
    // Custom two-round stream with pre-tool prose: the first round says
    // something before calling the tool — Claude Code-style, that prose
    // freezes into its own bubble when the round frame arrives.
    const enc = new TextEncoder()
    let releaseMine!: () => void
    const gateMine = new Promise<void>((r) => {
      releaseMine = r
    })
    chatStream = () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            enc.encode(
              sseFrames([
                { event: "user", data: { id: "m-p" } },
                { event: "delta", data: { text: "Ich prüfe das." } },
                { event: "round", data: {} },
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
                    result: '{"totalsCents":{"outflow":-421100}}',
                  },
                },
                { event: "delta", data: { text: "Ergebnis: 42,11 €." } },
              ])
            )
          )
          await gateMine
          controller.close()
        },
      })
    stubChatFlow(state)
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(screen.getByText("4211,00 €")).toBeInTheDocument()
    )

    const input = screen.getByPlaceholderText("Nachricht…")
    await userEvent.type(input, "Prüf mal?")
    await userEvent.click(screen.getByRole("button", { name: "Senden" }))

    // mid-stream: the pre-tool prose froze into its own bubble, the
    // chip lives with it, the final prose streams into the live bubble
    await waitFor(() =>
      expect(screen.getByText("Ich prüfe das.")).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(screen.getByText(/Ergebnis: 42,11 €\./)).toBeInTheDocument()
    )
    expect(screen.getAllByText("get_category_totals").length).toBeGreaterThan(0)

    // done: the persisted per-round rows replace the segments — both
    // bubbles survive as separate stored rows with the chip between
    const persistedRows = [
      ...state.messages,
      msg("p-r1", "assistant", "Ich prüfe das.", 3, {
        toolCalls: JSON.stringify([
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_category_totals",
              arguments: '{"period":"this_month"}',
            },
          },
        ]),
      }),
      msg("p-tool", "tool", '{"totalsCents":{"outflow":-421100}}', 4, {
        toolName: "get_category_totals",
        toolArgs: '{"period":"this_month"}',
        toolCallId: "call_1",
      }),
      msg("p-final", "assistant", "Ergebnis: 42,11 €.", 5),
    ]
    await act(async () => {
      state.messages = persistedRows
      releaseMine()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getAllByText("Ich prüfe das.")).toHaveLength(1)
    )
    expect(screen.getAllByText(/Ergebnis: 42,11 €\./)).toHaveLength(1)
    expect(screen.getAllByText("get_category_totals").length).toBeGreaterThan(0)
  }, 15_000)

  it("discards a retry-flagged round's segment (no Denkprozess-only bubble)", async () => {
    // The degenerate empty answer: the model streams ONLY a thinking
    // trace, the server retries tools-free. The retry-flagged round
    // persists no row — the client must discard the streamed segment
    // instead of freezing it, or a Denkprozess-only bubble lingers
    // until the post-done refetch drops it (the persisted transcript
    // has no row behind it).
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
    const enc = new TextEncoder()
    let releaseMine!: () => void
    const gateMine = new Promise<void>((r) => {
      releaseMine = r
    })
    chatStream = () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            enc.encode(
              sseFrames([
                { event: "user", data: { id: "m-p" } },
                { event: "reasoning", data: { text: "Erster Gedanke…" } },
                { event: "round", data: { retry: true } },
                { event: "delta", data: { text: "Eins" } },
              ])
            )
          )
          await gateMine
          controller.enqueue(
            enc.encode(
              sseFrames([
                { event: "round", data: {} },
                { event: "done", data: { messageId: "m10" } },
              ])
            )
          )
          controller.close()
        },
      })
    stubChatFlow(state)
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(screen.getByText("4211,00 €")).toBeInTheDocument()
    )

    const input = screen.getByPlaceholderText("Nachricht…")
    await userEvent.type(input, "Was?")
    await userEvent.click(screen.getByRole("button", { name: "Senden" }))

    // mid-stream: the retry's answer streams; the degenerate round's
    // segment is gone — only the seeded row's Denkprozess toggle remains
    // (with the freeze-the-segment bug the discarded round would add a
    // second, reasoning-only bubble)
    await waitFor(() => expect(screen.getByText("Eins")).toBeInTheDocument())
    expect(screen.queryByText("Erster Gedanke…")).not.toBeInTheDocument()
    expect(screen.getAllByText("Denkprozess")).toHaveLength(1)

    // done: the persisted transcript — user row + the retry's answer
    // row only (the degenerate round left no row) — replaces the
    // optimistic UI
    await act(async () => {
      state.messages = [
        ...seedMessages,
        msg("m-p", "user", "Was?", 3),
        msg("m10", "assistant", "Eins", 4),
      ]
      releaseMine()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getAllByText("Eins")).toHaveLength(1))
    expect(screen.getAllByText("Was?")).toHaveLength(1)
    expect(screen.getAllByText("Denkprozess")).toHaveLength(1)
  }, 15_000)

  it("raced detail fetch with the persisted user row shows the message once", async () => {
    // The first-send path: the turn's POST and the enable-racing detail
    // GET hit together, and the fetch result already contains the
    // persisted user row ("m-pending" — the id the user frame echoes).
    // Regression: optimistic bubble + stored row rendered the first
    // message twice for the whole streamed turn. The persisted row wins.
    const state = {
      // detail serves the appended user row ALREADY, mid-turn
      messages: [msg("m-pending", "user", "Wie viel?", 3)] as Array<
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
      expect(screen.getByText("Haushaltsfragen")).toBeInTheDocument()
    )
    // wait for the raced detail fetch to have landed (the row is shown)
    await waitFor(() =>
      expect(screen.getByText("Wie viel?")).toBeInTheDocument()
    )

    const input = screen.getByPlaceholderText("Nachricht…")
    await userEvent.type(input, "Wie viel?")
    await userEvent.click(screen.getByRole("button", { name: "Senden" }))

    // mid-stream: exactly ONE user bubble — the optimistic twin is
    // suppressed even though pendingUserMessage ("Wie viel?") is set and
    // the fetched list already contains the identical persisted row.
    await waitFor(() =>
      expect(
        screen.getByText(/Du hast 4211,00 € ausgegeben\./)
      ).toBeInTheDocument()
    )
    expect(screen.getAllByText("Wie viel?")).toHaveLength(1)

    // done: the persisted list arrives; dedupe retires by identity, still
    // exactly one user row and one assistant answer (the streamed bubble
    // replaced by the equivalent stored row m9)
    await act(async () => {
      state.messages = postTurnMessagesWithUser()
      releaseTurn()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByText("4211,00 €")).toBeInTheDocument()
    )
    expect(screen.getAllByText("Wie viel?")).toHaveLength(1)
    expect(screen.getAllByText(/Du hast 4211,00 € ausgegeben\./)).toHaveLength(
      1
    )
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

  it("keeps turn UI out of the other thread's list when switching mid-turn", async () => {
    // The dropdown stays usable while a turn streams; a thread switch must
    // not render the optimistic bubble or the streamed answer there.
    const state = {
      messages: [
        msg("m1", "user", "Wie viel habe ich diesen Monat ausgegeben?", 1),
      ],
      messagesT2: [msg("s1", "user", "Andere Frage", 1)],
      threads: [
        {
          id: "t1",
          title: "Haushaltsfragen",
          role: "owner",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "t2",
          title: "Zweiter Chat",
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
    const input = screen.getByPlaceholderText("Nachricht…")
    await userEvent.type(input, "Wie viel?")
    await userEvent.click(screen.getByRole("button", { name: "Senden" }))
    // mid-turn in t1: the optimistic bubble is visible here
    await waitFor(() =>
      expect(screen.getByText("Wie viel?")).toBeInTheDocument()
    )
    // switch to t2 while the turn holds (the stream is never released)
    await userEvent.click(screen.getByRole("button", { name: "2 Chats" }))
    await userEvent.click(screen.getByText("Zweiter Chat"))
    expect(screen.getByText("Andere Frage")).toBeInTheDocument()
    // neither the optimistic bubble nor the streamed turn leaks into t2
    expect(screen.queryByText("Wie viel?")).not.toBeInTheDocument()
    expect(screen.queryByText("get_category_totals")).not.toBeInTheDocument()

    // the turn still completes normally (held stream released now)
    await act(async () => {
      releaseTurn()
      await Promise.resolve()
    })
    expect(screen.getByText("Andere Frage")).toBeInTheDocument()
    expect(screen.queryByText("Wie viel?")).not.toBeInTheDocument()
  }, 15_000)

  it("puts the typed message back when the send is rejected pre-persist", async () => {
    // 400 = the server validated the content away BEFORE any persistence
    // (nothing was stored), so the composer must get the draft back.
    const state = {
      messages: [],
      chatReject: { status: 400, body: { error: "invalid_content" } },
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
    const input = screen.getByPlaceholderText("Nachricht…")
    await userEvent.type(input, "Meine ausgelöschte Frage")
    await userEvent.click(screen.getByRole("button", { name: "Senden" }))
    // the composer holds the message again once the turn hook resolves
    await waitFor(() => expect(input).toHaveValue("Meine ausgelöschte Frage"))
    // no optimistic bubble was left hanging either
    await waitFor(() =>
      expect(
        screen.queryByText("Meine ausgelöschte Frage")
      ).not.toBeInTheDocument()
    )
  }, 15_000)

  it("surfaces a deleted-thread 404 as its own message, not 'service unreachable'", async () => {
    // The thread routes' 404 carries {error: "not_found"} with no
    // message field: the owner deleted the thread mid-session while a
    // member typed. The generic "Chat-Dienst nicht erreichbar" fallback
    // would mislead — the 404 must map to a deleted-thread toast.
    const state = {
      messages: [],
      chatReject: { status: 404, body: { error: "not_found" } },
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
    const errorSpy = vi.spyOn(toast, "error")
    try {
      renderWithQuery(createElement(AgentChat))
      await waitFor(() =>
        expect(screen.getByText("Haushaltsfragen")).toBeInTheDocument()
      )
      const input = screen.getByPlaceholderText("Nachricht…")
      await userEvent.type(input, "An den gelöschten Chat?")
      await userEvent.click(screen.getByRole("button", { name: "Senden" }))
      await waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          "Dieser Chat existiert nicht mehr."
        )
      )
      expect(errorSpy).not.toHaveBeenCalledWith(
        "Der Chat-Dienst ist nicht erreichbar."
      )
      // pre-persist reject: the composer keeps the draft for a retry
      await waitFor(() => expect(input).toHaveValue("An den gelöschten Chat?"))
    } finally {
      errorSpy.mockRestore()
    }
  }, 15_000)

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

  it("never fetches the invited thread's messages; joining unlocks the fetch", async () => {
    // Regression: the detail query used to be enabled for invited
    // threads too — a role whose messages route 404s by design — so the
    // 4s poll fired a doomed request per tick until the user acted.
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
    // bespoke stub: the join flips the list role to member, as the real
    // threads endpoint would on refetch
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input).split("?")[0]
        const method = (init?.method ?? "GET").toUpperCase()
        calls.push({ path, method })
        if (path === "/api/agent/threads" && method === "GET") {
          return Response.json({ threads: state.threads })
        }
        if (path === "/api/agent/threads/t2/join" && method === "POST") {
          state.threads[0].role = "member"
          return Response.json({ joined: true })
        }
        if (path === "/api/agent/threads/t2/messages" && method === "GET") {
          if (state.threads[0].role === "invited") {
            return Response.json({ error: "not_found" }, { status: 404 })
          }
          return Response.json(threadDetail([], "member"))
        }
        throw new TypeError(`unscripted ${path} ${method}`)
      })
    )
    renderWithQuery(createElement(AgentChat))
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "1 Chats" })
      ).toBeInTheDocument()
    )
    await userEvent.click(screen.getByRole("button", { name: "1 Chats" }))
    await userEvent.click(screen.getByText("Geteilter Chat"))
    await waitFor(() =>
      expect(screen.getByText(/Einladung zu/)).toBeInTheDocument()
    )
    // the join panel renders from the list role alone: no messages
    // request fired for the still-invited thread
    expect(
      calls.filter(
        (c) => c.path === "/api/agent/threads/t2/messages" && c.method === "GET"
      )
    ).toHaveLength(0)

    await userEvent.click(screen.getByRole("button", { name: "Annehmen" }))
    // the refetched list reports member: the detail query unlocks and
    // fetches the now-readable messages
    await waitFor(() =>
      expect(
        calls.filter(
          (c) =>
            c.path === "/api/agent/threads/t2/messages" && c.method === "GET"
        ).length
      ).toBeGreaterThan(0)
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
