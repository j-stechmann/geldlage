import { describe, it, expect, beforeEach } from "vitest"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { TurnPersister } from "@/lib/agent/turn-persister"
import { createThread, listMessages } from "@/lib/agent/store"
import { seedUser } from "./helpers"

/**
 * TurnPersister unit tests (ADR-0033): the write-side state machine fed
 * with synthetic loop events, asserted against the stored rows — the
 * persistence contract later turns replay via rowsToPromptHistory.
 */

/** Mirrors the persister's cap; the cut itself is asserted via content. */
const TOOL_RESULT_MAX_CHARS = 8000

let db: Db
let threadId: string

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  threadId = createThread(seedUser(db)).id
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
    // the boundary itself stays unmarked: exactly the cap is not a cut
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
      result: "x".repeat(TOOL_RESULT_MAX_CHARS),
    })
    expect(listMessages(threadId)[1].content).toBe(
      "x".repeat(TOOL_RESULT_MAX_CHARS)
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
  })
})
