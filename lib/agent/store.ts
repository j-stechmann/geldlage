import { and, asc, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import {
  chatMessages,
  chatThreadMembers,
  chatThreads,
  users,
  type ChatMessage,
  type ChatThread,
} from "@/lib/db/schema"

/**
 * Persistence helpers for agent chat threads (ADR-0033). All synchronous
 * via getDb() (better-sqlite3): the chat routes run inside one request
 * handler and there is no writer concurrency worth awaiting. Roles: the
 * thread creator (chatThreads.userId) is the "owner" — the only one who
 * may invite/rename/delete; everyone else goes through chatThreadMembers
 * with state invited → joined.
 */

function nowIso(): string {
  return new Date().toISOString()
}

export function createThread(uid: number, title?: string): ChatThread {
  const db = getDb()
  const inserted = db
    .insert(chatThreads)
    .values({ userId: uid, ...(title !== undefined && { title }) })
    .returning()
    .get()
  if (!inserted) throw new Error("could not create chat thread")
  return inserted
}

export function getThread(id: string): ChatThread | undefined {
  const db = getDb()
  return db.select().from(chatThreads).where(eq(chatThreads.id, id)).get()
}

export type ThreadRole = "owner" | "member" | "invited" | null

/**
 * The caller's relationship to a thread: owner (creator), member (joined,
 * full read/participate), invited (title-only preview) or null (no
 * relation — every route gates on this before any read/write).
 */
export function roleOf(threadId: string, uid: number): ThreadRole {
  const db = getDb()
  const thread = db
    .select({ userId: chatThreads.userId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .get()
  if (!thread) return null
  if (thread.userId === uid) return "owner"
  const membership = db
    .select({ state: chatThreadMembers.state })
    .from(chatThreadMembers)
    .where(
      and(
        eq(chatThreadMembers.threadId, threadId),
        eq(chatThreadMembers.userId, uid)
      )
    )
    .get()
  if (!membership) return null
  // only those two states exist (CHECK-free but default-seeded); a stray
  // value degrades to invited (least privilege) rather than member
  return membership.state === "joined" ? "member" : "invited"
}

/**
 * Thread list for the sidebar: owned threads plus accepted/shared ones in
 * one pass, newest activity first. Role is attached so the UI can render
 * badges without a second query per thread.
 */
export function listThreadsForUser(
  uid: number
): Array<ChatThread & { role: "owner" | "member" | "invited" }> {
  const db = getDb()
  const owned = db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.userId, uid))
    .all()
    .map((t) => ({ ...t, role: "owner" as const }))
  const memberships = db
    .select({ thread: chatThreads, state: chatThreadMembers.state })
    .from(chatThreadMembers)
    .innerJoin(chatThreads, eq(chatThreads.id, chatThreadMembers.threadId))
    .where(eq(chatThreadMembers.userId, uid))
    .all()
    .map((row) => ({
      ...row.thread,
      role: row.state === "joined" ? ("member" as const) : ("invited" as const),
    }))
  // The owner is never in chatThreadMembers (inviteMembers skips them), but
  // a defensive dedupe keeps an accidental double-row from rendering twice.
  const byId = new Map<
    string,
    ChatThread & { role: "owner" | "member" | "invited" }
  >()
  for (const t of [...owned, ...memberships]) {
    const existing = byId.get(t.id)
    // owner beats member beats invited in the (impossible) overlap case
    if (!existing || rankOf(existing.role) < rankOf(t.role)) byId.set(t.id, t)
  }
  return [...byId.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
}

function rankOf(role: "owner" | "member" | "invited"): number {
  return role === "owner" ? 2 : role === "member" ? 1 : 0
}

export function touchThread(threadId: string): void {
  const db = getDb()
  db.update(chatThreads)
    .set({ updatedAt: nowIso() })
    .where(eq(chatThreads.id, threadId))
    .run()
}

export function renameThread(threadId: string, title: string): void {
  const db = getDb()
  db.update(chatThreads)
    .set({ title, updatedAt: nowIso() })
    .where(eq(chatThreads.id, threadId))
    .run()
}

/**
 * Auto-titling for the first user turn: only fires while the thread still
 * wears the default title ("Neuer Chat") — a user-chosen name is never
 * overwritten by later messages. 24 chars keeps sidebar rows single-line.
 */
export function setTitleIfDefault(
  threadId: string,
  firstUserMessage: string
): void {
  const db = getDb()
  const thread = getThread(threadId)
  if (!thread || thread.title !== "Neuer Chat") return
  const singleLine = firstUserMessage.replace(/\s+/g, " ").trim()
  const title =
    singleLine.length > 24 ? singleLine.slice(0, 24) + "…" : singleLine
  if (!title) return
  db.update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId))
    .run()
}

export interface ThreadMember {
  userId: number
  name: string
  email: string
  state: string
}

/**
 * Participants of a thread with display-name/email (join users). The
 * creator is synthesized (not stored in chatThreadMembers) so the UI shows
 * one consistent member list.
 */
export function listMembers(threadId: string): ThreadMember[] {
  const db = getDb()
  const thread = db
    .select({ userId: chatThreads.userId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .get()
  const rows = db
    .select({
      userId: chatThreadMembers.userId,
      name: users.name,
      email: users.email,
      state: chatThreadMembers.state,
    })
    .from(chatThreadMembers)
    .innerJoin(users, eq(users.id, chatThreadMembers.userId))
    .where(eq(chatThreadMembers.threadId, threadId))
    .all()
  if (!thread) return rows
  // owner synthesized, never duplicated (inviteMembers refuses the owner id)
  const owner = db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, thread.userId))
    .get()
  if (!owner) return rows
  return [
    {
      userId: thread.userId,
      name: owner.name,
      email: owner.email,
      state: "owner",
    },
    ...rows,
  ]
}

/**
 * Invite users to a thread. Idempotent: onConflictDoNothing on the
 * (threadId, userId) primary key makes re-invites and self-invites of
 * existing members no-ops; the returning() count is the number of rows
 * actually inserted (0 for everything already present). The owner cannot
 * be invited — they already hold full rights.
 */
export function inviteMembers(threadId: string, userIds: number[]): number {
  const db = getDb()
  const thread = getThread(threadId)
  if (!thread) return 0
  const unique = [...new Set(userIds)].filter((id) => id !== thread.userId)
  if (unique.length === 0) return 0
  const inserted = db
    .insert(chatThreadMembers)
    .values(
      unique.map((userId) => ({
        threadId,
        userId,
        state: "invited" as const,
        createdAt: nowIso(),
      }))
    )
    .onConflictDoNothing()
    .returning({ userId: chatThreadMembers.userId })
    .all()
  return inserted.length
}

export function removeMember(threadId: string, userId: number): boolean {
  const db = getDb()
  const result = db
    .delete(chatThreadMembers)
    .where(
      and(
        eq(chatThreadMembers.threadId, threadId),
        eq(chatThreadMembers.userId, userId)
      )
    )
    .run()
  return result.changes > 0
}

/**
 * Accept an invite: only invited → joined, never a downgrade of anything
 * else (the boolean tells the route whether the caller actually held an
 * invite — a stale client call on an already-joined membership returns
 * false instead of fabricating state).
 */
export function setMemberState(
  threadId: string,
  userId: number,
  state: "joined"
): boolean {
  const db = getDb()
  const result = db
    .update(chatThreadMembers)
    .set({ state })
    .where(
      and(
        eq(chatThreadMembers.threadId, threadId),
        eq(chatThreadMembers.userId, userId),
        eq(chatThreadMembers.state, "invited")
      )
    )
    .run()
  return result.changes > 0
}

/** Deletes the thread; members + messages go via ON DELETE CASCADE. */
export function deleteThread(threadId: string): void {
  const db = getDb()
  db.delete(chatThreads).where(eq(chatThreads.id, threadId)).run()
}

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
    const bump = msg.role === "tool" ? {} : { updatedAt: nowIso() }
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
        createdAt: nowIso(),
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
