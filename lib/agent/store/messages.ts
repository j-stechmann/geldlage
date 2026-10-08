import { asc, desc, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { chatMessages, chatThreads, type ChatMessage } from "@/lib/db/schema"
import { DEFAULT_THREAD_TITLE } from "@/lib/agent/constants"

/**
 * Chat message persistence (ADR-0033): appends with a per-thread seq
 * counter and reads back in display AND loop order. Split from store.ts so
 * message concern stands alone from thread/member management.
 */

export { DEFAULT_THREAD_TITLE }

/**
 * Appends one message atomically: the per-thread seq must advance in the
 * same transaction the row inserts in, or two concurrent writers could
 * grab the same threadSeq (better-sqlite3 is single-writer, but the
 * invariant is kept locally obvious rather than luck-based). updatedAt
 * bumps only for user/assistant roles — tool rows are invisible plumbing
 * and must not reorder the newest-first thread list mid-turn.
 */
export function appendMessage(
  threadId: string,
  msg: {
    userId: number | null
    role: "user" | "assistant" | "tool"
    content: string
    reasoning?: string | null
    toolName?: string | null
    toolArgs?: string | null
  }
): ChatMessage {
  const db = getDb()
  let inserted: ChatMessage | undefined
  db.transaction((tx) => {
    const current = tx
      .select({ seq: chatThreads.seq })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .get()
    if (!current) throw new Error(`thread not found: ${threadId}`)
    const nextSeq = current.seq + 1
    const bump =
      msg.role === "tool" ? {} : { updatedAt: new Date().toISOString() }
    tx.update(chatThreads)
      .set({ seq: nextSeq, ...bump })
      .where(eq(chatThreads.id, threadId))
      .run()
    inserted = tx
      .insert(chatMessages)
      .values({
        threadId,
        userId: msg.userId,
        role: msg.role,
        content: msg.content,
        reasoning: msg.reasoning ?? null,
        toolName: msg.toolName ?? null,
        toolArgs: msg.toolArgs ?? null,
        threadSeq: nextSeq,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get()
  })
  if (!inserted) throw new Error("could not append chat message")
  return inserted
}

/**
 * Message list for a thread in display AND loop order: threadSeq is the
 * monotonic per-thread counter, id the deterministic tiebreak (the index
 * chat_messages_thread_sort_idx is built for exactly this ORDER BY).
 */
export function listMessages(threadId: string): ChatMessage[] {
  const db = getDb()
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.threadSeq), asc(chatMessages.id))
    .all()
}

/**
 * The last `limit` messages in the same order — the bounded read the chat
 * route's history mapping uses. The full list stays O(thread size) per
 * turn otherwise; SQLite walks chat_messages_thread_sort_idx backwards
 * for this ORDER BY … LIMIT, so the cost tracks the window, not the
 * thread. Callers needing the whole thread (display/detail) keep
 * listMessages; a windowed slice is only valid when nothing before the
 * window is read (the loop's own cap is what makes this safe).
 */
export function listRecentMessages(
  threadId: string,
  limit: number
): ChatMessage[] {
  const db = getDb()
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.threadSeq), desc(chatMessages.id))
    .limit(limit)
    .all()
    .reverse()
}
