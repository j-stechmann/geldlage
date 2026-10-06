import { NextRequest, NextResponse } from "next/server"
import { removeMember, roleOf } from "@/lib/agent/store"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Owner removes/retracts one invite or membership. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id, userId: rawUserId } = await params
  if (roleOf(id, session.uid) !== "owner") {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  const userId = Number.parseInt(rawUserId, 10)
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 })
  }

  if (userId === session.uid) {
    return NextResponse.json(
      {
        error: "cannot_remove_owner",
        message: "Der Besitzer kann nicht entfernt werden.",
      },
      { status: 400 }
    )
  }

  const removed = removeMember(id, userId)
  return NextResponse.json({ removed })
}
