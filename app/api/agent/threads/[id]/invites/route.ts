import { NextRequest, NextResponse } from "next/server"
import { getThread, inviteMembers, listMembers } from "@/lib/agent/store"
import { requireThreadAccess } from "@/lib/agent/route-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Owner-only invite management. Non-owners get 404 (never 403): an error
 * that distinguishes "exists but forbidden" would leak which thread ids
 * belong to other users.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const gate = await requireThreadAccess(request, id, ["owner"], {
    csrf: false,
  })
  if (!gate.ok) return gate.response
  // Same concurrent-delete race as the owner gate itself: the thread row
  // can vanish between roleOf and this read, so an explicit check keeps
  // the 404 body instead of an unhandled 500.
  const thread = getThread(id)
  if (!thread) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json({ members: listMembers(id, thread.userId) })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const gate = await requireThreadAccess(request, id, ["owner"])
  if (!gate.ok) return gate.response

  const body = (await request.json().catch(() => null)) as {
    userIds?: unknown
  } | null
  const userIds = body?.userIds
  const valid =
    Array.isArray(userIds) &&
    userIds.length > 0 &&
    userIds.every((v) => typeof v === "number" && Number.isInteger(v) && v > 0)
  if (!valid) {
    return NextResponse.json(
      {
        error: "invalid_user_ids",
        message: "userIds muss eine Liste von Benutzer-IDs sein.",
      },
      { status: 400 }
    )
  }

  // inviteMembers is idempotent (conflict-do-nothing insert) and refuses
  // the owner id; the return count = rows actually added. Foreign-key
  // violations (a stale dialog submitting a since-deleted user id) are
  // caught here — onConflictDoNothing does NOT suppress FK failures — and
  // surface as 400 unknown_user instead of an unhandled 500. The thread
  // row can still vanish between the roleOf gate and this read (owner
  // deleted it concurrently), so the same check maps that to 404.
  try {
    const thread = getThread(id)
    if (!thread) {
      return NextResponse.json({ error: "not_found" }, { status: 404 })
    }
    const invited = inviteMembers(id, userIds, thread.userId)
    return NextResponse.json({ invited })
  } catch (err) {
    if (isForeignKeyError(err)) {
      return NextResponse.json(
        {
          error: "unknown_user",
          message: "Ein Benutzer existiert nicht (mehr).",
        },
        { status: 400 }
      )
    }
    throw err
  }
}

/** SQLite FK violation (better-sqlite3 SqliteError code FOREIGN_KEY_…). */
function isForeignKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    (err as { code: string }).code.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY")
  )
}
