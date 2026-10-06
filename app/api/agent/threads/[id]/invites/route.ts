import { NextRequest, NextResponse } from "next/server"
import { inviteMembers, listMembers, roleOf } from "@/lib/agent/store"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

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
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const { id } = await params
  if (roleOf(id, session.uid) !== "owner") {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json({ members: listMembers(id) })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params
  if (roleOf(id, session.uid) !== "owner") {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

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
  // surface as 400 unknown_user instead of an unhandled 500.
  try {
    const invited = inviteMembers(id, userIds)
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
