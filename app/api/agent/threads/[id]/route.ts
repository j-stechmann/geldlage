import { NextRequest, NextResponse } from "next/server"
import {
  deleteThread,
  getThread,
  removeMember,
  renameThread,
  roleOf,
} from "@/lib/agent/store"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Thread detail mutations. Every branch answers 404 instead of 403 for
 * foreign or existing-but-forbidden threads: a 403 would confirm to an
 * authenticated outsider that the id belongs to someone else's thread
 * (existence disclosure), while 404 is indistinguishable from a random id.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params

  const body = (await request.json().catch(() => null)) as {
    title?: unknown
  } | null
  if (typeof body?.title !== "string") {
    return NextResponse.json(
      { error: "invalid_title", message: "Titel muss ein Text sein." },
      { status: 400 }
    )
  }
  const title = body.title.trim()
  if (title.length < 1 || title.length > 80) {
    return NextResponse.json(
      { error: "invalid_title", message: "Titel: 1–80 Zeichen." },
      { status: 400 }
    )
  }

  // Owner-only gate AFTER validation: non-owners can't rename, and they
  // can't learn whether the thread exists.
  if (roleOf(id, session.uid) !== "owner") {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  if (!getThread(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  renameThread(id, title)
  return NextResponse.json({ thread: getThread(id) })
}

/**
 * Role-dependent teardown: owner deletes the whole thread (members and
 * messages cascade); invited/joined members leave or decline, keeping the
 * thread intact for everyone else. Same 404-vs-leak reasoning as PATCH.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params

  const role = roleOf(id, session.uid)
  if (!role) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  if (role === "owner") {
    deleteThread(id)
    return NextResponse.json({ deleted: true })
  }
  removeMember(id, session.uid)
  return NextResponse.json({ left: true })
}
