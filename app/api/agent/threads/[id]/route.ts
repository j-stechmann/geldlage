import { NextRequest, NextResponse } from "next/server"
import {
  deleteThread,
  getThread,
  removeMember,
  renameThread,
} from "@/lib/agent/store"
import { requireThreadAccess } from "@/lib/agent/route-guard"

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
  const { id } = await params
  const gate = await requireThreadAccess(request, id, ["owner"])
  if (!gate.ok) return gate.response

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

  renameThread(id, title)
  // The thread can vanish concurrently (owner deleted it in another
  // session) between the rename and this read — same race the invites
  // routes handle, mapped to 404 like every other miss on this id.
  const thread = getThread(id)
  if (!thread) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json({ thread })
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
  const { id } = await params
  const gate = await requireThreadAccess(request, id, [
    "owner",
    "member",
    "invited",
  ])
  if (!gate.ok) return gate.response
  const role = gate.role!
  if (role === "owner") {
    deleteThread(id)
    return NextResponse.json({ deleted: true })
  }
  removeMember(id, gate.session.uid)
  return NextResponse.json({ left: true })
}
