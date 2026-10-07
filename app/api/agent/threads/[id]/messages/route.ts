import { NextRequest, NextResponse } from "next/server"
import { findUserById } from "@/lib/auth/users"
import { getThread, listMembers, listMessages } from "@/lib/agent/store"
import { requireThreadAccess } from "@/lib/agent/route-guard"

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
  const { id } = await params
  const gate = await requireThreadAccess(request, id, ["owner", "member"], {
    csrf: false,
  })
  if (!gate.ok) return gate.response

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
    role: gate.role,
    members: listMembers(id, thread.userId),
    messages: listMessages(id),
  })
}
