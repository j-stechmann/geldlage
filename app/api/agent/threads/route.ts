import { NextRequest, NextResponse } from "next/server"
import { createThread, listThreadsForUser } from "@/lib/agent/store"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Sidebar list: owned + shared threads with the caller's role attached. */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  return NextResponse.json({
    threads: [...listThreadsForUser(session.uid)],
  })
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf

  // Optional title: trim, cap at 80 chars, fall back to the schema default
  // when absent/empty/non-string (the empty thread list needs zero ceremony).
  const body = (await request.json().catch(() => null)) as {
    title?: unknown
  } | null
  let title = "Neuer Chat"
  if (typeof body?.title === "string") {
    const trimmed = body.title.trim()
    if (trimmed) title = trimmed.slice(0, 80)
  }

  const thread = createThread(session.uid, title)
  return NextResponse.json({ thread }, { status: 201 })
}
