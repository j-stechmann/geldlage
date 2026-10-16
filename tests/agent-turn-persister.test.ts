import { describe, it, expect, beforeEach } from "vitest"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import {
  TurnPersister,
  TOOL_RESULT_MAX_CHARS,
} from "@/lib/agent/turn-persister"
import {
  AGENT_MAX_FIELD_CHARS,
  AGENT_NO_ANSWER_TEXT,
} from "@/lib/agent/constants"
import { rowsToPromptHistory } from "@/lib/agent/history"
import { windowHistory } from "@/lib/agent/window"
import { appendMessage, createThread, listMessages } from "@/lib/agent/store"
import { seedUser } from "./helpers"

/**
 * TurnPersister unit tests (ADR-0033): the write-side state machine fed
 * with synthetic loop events, asserted against the stored rows — the
 * persistence contract later turns replay via rowsToPromptHistory.
 */

let db: Db
let uid: number
let threadId: string

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  uid = seedUser(db)
  threadId = createThread(uid).id
})

describe("TurnPersister tool results", () => {
  it("stores a fitting tool result verbatim", () => {
    const p = new TurnPersister(threadId)
    p.onLoopEvent({
      type: "tool_call",
      id: "c1",
      name: "get_category_totals",
      args: "{}",
    })
    expect(
      p.onLoopEvent({
        type: "tool_result",
        id: "c1",
        name: "get_category_totals",
        result: '{"ok":true}',
      })
    ).toBeNull()
    const rows = listMessages(threadId)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe("tool")
    expect(rows[0].content).toBe('{"ok":true}')
    expect(rows[0].toolCallId).toBe("c1")
    // the replay-cap boundary itself stays unmarked: exactly
    // AGENT_MAX_FIELD_CHARS is not a cut — windowHistory passes it
    // through untouched, and marking an uncut result would lie
    const p2 = new TurnPersister(threadId)
    p2.onLoopEvent({
      type: "tool_call",
      id: "c2",
      name: "get_category_totals",
      args: "{}",
    })
    p2.onLoopEvent({
      type: "tool_result",
      id: "c2",
      name: "get_category_totals",
      result: "x".repeat(AGENT_MAX_FIELD_CHARS),
    })
    expect(listMessages(threadId)[1].content).toBe(
      "x".repeat(AGENT_MAX_FIELD_CHARS)
    )
  })

  it("caps an oversized tool result and marks the cut", () => {
    const p = new TurnPersister(threadId)
    // ~80+ active categories worth of JSON overflows the per-row cap;
    // the stored copy must announce the cut so a later turn's replay
    // never feeds the model a silently broken JSON answer.
    const big =
      '{"categories":' +
      JSON.stringify(
        Array.from({ length: 200 }, (_, i) => ({
          category: `Kat-${i}`,
          inflowCents: i,
          outflowCents: -i,
          count: 1,
        }))
      ) +
      "}"
    p.onLoopEvent({
      type: "tool_call",
      id: "c1",
      name: "get_category_totals",
      args: "{}",
    })
    p.onLoopEvent({
      type: "tool_result",
      id: "c1",
      name: "get_category_totals",
      result: big,
    })
    const rows = listMessages(threadId)
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe(
      big.slice(0, TOOL_RESULT_MAX_CHARS) + " …[Ergebnis gekürzt]"
    )
    // slice + marker fit the replay cap exactly: windowHistory's
    // per-field truncation must never re-cut the stored row
    expect(rows[0].content.length).toBe(AGENT_MAX_FIELD_CHARS)
  })

  it("keeps the truncation marker through the replay window (regression)", () => {
    // Regression: the stored cap (8000) used to exceed
    // AGENT_MAX_FIELD_CHARS (4000), so a later turn's replay re-cut the
    // stored row through windowHistory — the marker fell off and the
    // model saw broken JSON with a bare "…". The stored copy must fit
    // the replay cap, marker included.
    appendMessage(threadId, { userId: uid, role: "user", content: "Summen?" })
    const p = new TurnPersister(threadId)
    p.onLoopEvent({
      type: "round",
      content: "",
      reasoning: null,
      calls: [{ id: "c1", name: "get_category_totals", args: "{}" }],
      retry: false,
    })
    p.onLoopEvent({
      type: "tool_call",
      id: "c1",
      name: "get_category_totals",
      args: "{}",
    })
    p.onLoopEvent({
      type: "tool_result",
      id: "c1",
      name: "get_category_totals",
      result: "x".repeat(AGENT_MAX_FIELD_CHARS * 3),
    })
    p.onLoopEvent({ type: "done" })

    // A later turn's view of the thread: stored rows → protocol
    // history → the loop's replay window. A generous budget isolates
    // the per-field truncation from the head/tail slicing.
    const windowed = windowHistory(
      rowsToPromptHistory(listMessages(threadId)),
      Number.MAX_SAFE_INTEGER
    )
    const toolMsg = windowed.find((m) => m.role === "tool")
    expect(toolMsg).toBeDefined()
    // the marker survived truncateField — not re-cut with a bare "…"
    expect(toolMsg!.content.endsWith(" …[Ergebnis gekürzt]")).toBe(true)
    expect(toolMsg!.content.length).toBeLessThanOrEqual(AGENT_MAX_FIELD_CHARS)
  })
})

describe("TurnPersister reasoning-only turn ends", () => {
  it("persists the display placeholder but replays it as empty content (regression)", () => {
    // Regression: a callless final round streaming only a thinking trace
    // persists the AGENT_NO_ANSWER_TEXT body (empty bubble otherwise),
    // but the placeholder is UI copy — rowsToPromptHistory must strip
    // it, or every later prompt quotes it as the model's own answer.
    appendMessage(threadId, { userId: uid, role: "user", content: "Und?" })
    const p = new TurnPersister(threadId)
    p.onLoopEvent({
      type: "round",
      content: "",
      reasoning: "Nur ein Gedanke.",
      calls: [],
      retry: false,
    })

    const rows = listMessages(threadId)
    const assistant = rows.find((r) => r.role === "assistant")!
    // the stored row keeps the placeholder: the message list renders it
    expect(assistant.content).toBe(AGENT_NO_ANSWER_TEXT)
    expect(assistant.reasoning).toBe("Nur ein Gedanke.")

    // the wire history carries the empty prose the round streamed
    expect(rowsToPromptHistory(rows)).toEqual([
      { role: "user", content: "Und?" },
      { role: "assistant", content: "" },
    ])
  })
})
