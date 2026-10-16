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
  // The segment must be one canonical positive integer: parseInt alone
  // would read "3.7" as 3, silently retargeting the removal at user 3.
  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    String(userId) !== rawUserId
  ) {
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

  // The state is the removed row's PRIOR state (null when the row was
  // already gone — still success, the desired roster holds either
  // way): the client toasts what the server removed, never its
  // possibly-stale roster copy (an invited user may have joined since
  // the roster was fetched).
  const state = removeMember(id, userId)
  return NextResponse.json({ removed: state !== null, state })
}
