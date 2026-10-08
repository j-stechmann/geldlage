import { NextRequest, NextResponse } from "next/server"
import type { SessionClaims } from "@/lib/auth/session"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"
import { roleOf, type ThreadRole } from "@/lib/agent/store/thread-access"

/**
 * Access gates for agent routes (ADR-0033): one function instead of seven
 * copies of session → CSRF → roleOf → 404. The 404-not-403 rule is
 * deliberate — a 403 would confirm to an authenticated outsider that the
 * id belongs to someone else's thread (existence disclosure), while a 404
 * is indistinguishable from a random id.
 */

/** A role list the route accepts, e.g. ["owner"] or ["owner", "member"]. */
export type RequiredRole = Exclude<ThreadRole, null>

export type Gate =
  | { ok: true; session: SessionClaims; role?: RequiredRole }
  | { ok: false; response: Response }

/**
 * Session + CSRF only (routes with no thread id: list/create). CSRF skips
 * for GETs via `csrf: false` — mutating verbs run assertSameOrigin.
 */
export async function requireSessionGate(
  request: NextRequest,
  options: { csrf?: boolean } = {}
): Promise<Gate> {
  const session = await requireSession(request)
  if (!session) return { ok: false, response: unauthorized() }
  if (options.csrf !== false) {
    const csrf = assertSameOrigin(request)
    if (csrf) return { ok: false, response: csrf }
  }
  return { ok: true, session }
}

/**
 * requireSessionGate + a roleOf check on the thread: any failure past the
 * 401/403 collapses into the same 404 body, so forbidden and unknown
 * threads are indistinguishable.
 */
export async function requireThreadAccess(
  request: NextRequest,
  threadId: string,
  roles: RequiredRole[],
  options: { csrf?: boolean } = {}
): Promise<Gate> {
  const gate = await requireSessionGate(request, options)
  if (!gate.ok) return gate
  const role = roleOf(threadId, gate.session.uid)
  if (!role || !roles.includes(role)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "not_found" }, { status: 404 }),
    }
  }
  return { ok: true, session: gate.session, role }
}
