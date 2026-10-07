import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { chatThreadMembers, users } from "@/lib/db/schema"

/**
 * Chat thread membership (ADR-0033): invite-based sharing with the state
 * machine invited → joined. The creator is never stored in
 * chat_thread_members — they hold owner rights implicitly, and member
 * listings synthesize them.
 */

function nowIso(): string {
  return new Date().toISOString()
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
export function listMembers(
  threadId: string,
  ownerId?: number
): ThreadMember[] {
  const db = getDb()
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
  if (ownerId === undefined) return rows
  // owner synthesized, never duplicated (inviteMembers refuses the owner id)
  const owner = db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, ownerId))
    .get()
  if (!owner) return rows
  return [
    {
      userId: ownerId,
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
export function inviteMembers(
  threadId: string,
  userIds: number[],
  ownerId: number
): number {
  const db = getDb()
  const unique = [...new Set(userIds)].filter((id) => id !== ownerId)
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
