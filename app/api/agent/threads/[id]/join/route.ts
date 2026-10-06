import { NextRequest, NextResponse } from "next/server"
import { roleOf, setMemberState } from "@/lib/agent/store"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

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
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params

  const role = roleOf(id, session.uid)
  if (role === "owner" || role === "member") {
    return NextResponse.json({ joined: true })
  }
  if (role !== "invited" || !setMemberState(id, session.uid, "joined")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json({ joined: true })
}
