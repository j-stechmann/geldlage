import { NextRequest, NextResponse } from "next/server"
import { removeMember } from "@/lib/agent/store"
import { requireThreadAccess } from "@/lib/agent/route-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Owner removes/retracts one invite or membership. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const { id, userId: rawUserId } = await params
  const gate = await requireThreadAccess(request, id, ["owner"])
  if (!gate.ok) return gate.response

  const userId = Number.parseInt(rawUserId, 10)
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 })
  }

  if (userId === gate.session.uid) {
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
