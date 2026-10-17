import { NextRequest, NextResponse } from "next/server"
import { setMemberState } from "@/lib/agent/store"
import { requireThreadAccess } from "@/lib/agent/route-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Accept an invite (invited → joined). Idempotent for owner/member (they
 * already hold full rights — joining again is a client-visible no-op), 404
 * for unknown threads and uninvited users alike (no existence disclosure).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const gate = await requireThreadAccess(request, id, [
    "owner",
    "member",
    "invited",
  ])
  if (!gate.ok) return gate.response
  const role = gate.role!

  if (role === "owner" || role === "member") {
    return NextResponse.json({ joined: true })
  }
  if (!setMemberState(id, gate.session.uid, "joined")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json({ joined: true })
}
