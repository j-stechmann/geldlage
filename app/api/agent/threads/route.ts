import { NextRequest, NextResponse } from "next/server"
import {
  createThread,
  listThreadsForUser,
  DEFAULT_THREAD_TITLE,
} from "@/lib/agent/store"
import { requireSessionGate } from "@/lib/agent/route-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Sidebar list: owned + shared threads with the caller's role attached. */
export async function GET(request: NextRequest) {
  const gate = await requireSessionGate(request, { csrf: false })
  if (!gate.ok) return gate.response
  return NextResponse.json({
    threads: [...listThreadsForUser(gate.session.uid)],
  })
}

export async function POST(request: NextRequest) {
  const gate = await requireSessionGate(request)
  if (!gate.ok) return gate.response

  // Optional title: trim, cap at 80 chars, fall back to the schema default
  // when absent/empty/non-string (the empty thread list needs zero ceremony).
  const body = (await request.json().catch(() => null)) as {
    title?: unknown
  } | null
  let title = DEFAULT_THREAD_TITLE
  if (typeof body?.title === "string") {
    const trimmed = body.title.trim()
    if (trimmed) title = trimmed.slice(0, 80)
  }

  const thread = createThread(gate.session.uid, title)
  return NextResponse.json({ thread }, { status: 201 })
}
