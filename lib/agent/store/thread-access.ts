import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { chatThreadMembers, chatThreads } from "@/lib/db/schema"

/**
 * Thread access roles (ADR-0033): the caller's relationship to a thread,
 * computed from ownership + membership rows. Every agent route gates on
 * this before any read/write (404 for no relation — never 403, no
 * existence disclosure).
 */

/** The one role union — every consumer imports it from here. */
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

/** Owner beats member beats invited — dedupe/order key for listings. */
export function rankOf(role: Exclude<ThreadRole, null>): number {
  return role === "owner" ? 2 : role === "member" ? 1 : 0
}
