import { NextRequest, NextResponse } from "next/server"
import { listOccurrences } from "@/lib/planning/service"
import { todayLocal } from "@/lib/dates"
import { parseOptionalAccountId, parseWindow } from "@/lib/api/query"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Expanded occurrences in a window (with read-time match state) — what the
 * calendar, the plan list and the dashboard merge consume.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  const window = parseWindow(sp, todayLocal(), {
    fromDefault: "today",
    toDefaultDays: 89,
  })
  if (!window.ok) {
    return NextResponse.json(
      { error: window.error, message: window.message },
      { status: 400 }
    )
  }
  const account = parseOptionalAccountId(sp.get("accountId"))
  if (!account.ok) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 })
  }

  const occurrences = listOccurrences(
    session.uid,
    { from: window.from, to: window.to },
    account.value
  )
  return NextResponse.json({ occurrences })
}
