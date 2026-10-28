import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { accounts } from "@/lib/db/schema"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"
import { and, eq } from "drizzle-orm"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const db = getDb()
  const rows = db
    .select()
    .from(accounts)
    .where(eq(accounts.userId, session.uid))
    .all()
  return NextResponse.json({ accounts: rows })
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const body = (await request.json().catch(() => null)) as {
    iban?: string
    name?: string
  } | null
  if (!body?.iban || !body?.name) {
    return NextResponse.json(
      { error: "iban and name required" },
      { status: 400 }
    )
  }
  const db = getDb()
  const inserted = db
    .insert(accounts)
    .values({
      userId: session.uid,
      iban: body.iban.toUpperCase(),
      name: body.name,
    })
    .onConflictDoNothing()
    .returning()
    .get()
  return NextResponse.json({ account: inserted }, { status: 201 })
}

export async function DELETE(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const iban = new URL(request.url).searchParams.get("iban")
  if (!iban) {
    return NextResponse.json({ error: "iban required" }, { status: 400 })
  }
  const db = getDb()
  try {
    const result = db
      .delete(accounts)
      .where(
        and(
          eq(accounts.userId, session.uid),
          eq(accounts.iban, iban.toUpperCase())
        )
      )
      .run()
    if (result.changes === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 })
    }
    return NextResponse.json({ deleted: result.changes })
  } catch (err) {
    // accounts own transactions/import_batches/planned_transactions (FK, no
    // cascade): an account with history or plans cannot be dropped wholesale
    if (
      err instanceof Error &&
      err.message.includes("FOREIGN KEY constraint failed")
    ) {
      return NextResponse.json(
        {
          error: "account_in_use",
          message: "account has transactions, import batches or plans",
        },
        { status: 409 }
      )
    }
    throw err
  }
}
