import { asc } from "drizzle-orm"
import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/*
 * Full user directory for the invite dialog (ADR-0033). On a local,
 * self-hosted instance every OIDC-provisioned identity is inside the same
 * trust boundary (the provider gates who gets a workspace at all, per
 * ADR-0032), so name/email of all users are deliberately surfaced to any
 * logged-in user — per-row redaction would buy nothing here. The requesting
 * user is filtered out server-side (inviting yourself is meaningless) so
 * the dialog needs no special-casing; the thread owner is excluded
 * client-side instead.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const db = getDb()
  const rows = db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .orderBy(asc(users.name))
    .all()
  return NextResponse.json({
    users: rows.filter((u) => u.id !== session.uid),
  })
}
