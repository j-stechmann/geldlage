import { NextRequest, NextResponse } from "next/server"
import { findUserById } from "@/lib/auth/users"
import { getThread, listMembers, listMessages, roleOf } from "@/lib/agent/store"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Full thread view for members (and owner): thread meta, member roster and
 * messages as stored. Invited users preview at title-level only — their
 * invites are surfaced in the sidebar, and the full read unlocks exactly
 * on join, so an invite link is not a content leak; hence 404 for them,
 * same rationale as the owner-only mutations (no existence disclosure).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const { id } = await params

  const role = roleOf(id, session.uid)
  if (role !== "owner" && role !== "member") {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  const thread = getThread(id)
  if (!thread) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const owner = findUserById(thread.userId)
  return NextResponse.json({
    thread: {
      id: thread.id,
      title: thread.title,
      ownerId: thread.userId,
      ownerName: owner?.name ?? "",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    role,
    members: listMembers(id),
    messages: listMessages(id),
  })
}
