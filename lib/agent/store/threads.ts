import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import {
  chatThreadMembers,
  chatThreads,
  type ChatThread,
} from "@/lib/db/schema"
import { rankOf } from "@/lib/agent/store/thread-access"

/**
 * Chat thread lifecycle (ADR-0033): creation, listing with roles,
 * rename/touch/delete and the auto-title rule. Split from store.ts.
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

/** Deletes the thread; members + messages go via ON DELETE CASCADE. */
export function deleteThread(threadId: string): void {
  const db = getDb()
  db.delete(chatThreads).where(eq(chatThreads.id, threadId)).run()
}
