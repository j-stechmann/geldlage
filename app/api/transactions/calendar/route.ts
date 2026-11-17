import { NextRequest, NextResponse } from "next/server"
import { todayLocal } from "@/lib/dates"
import { parseOptionalAccountId, parseWindow } from "@/lib/api/query"
import { queryCalendarTransactions } from "@/lib/analytics/queries"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Compact bank rows (booked + pending) for a calendar window — what the
 * /calendar renders as "real" chips beside the planned occurrences. Not
 * paginated (the window cap bounds it).
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  // Same window contract as GET /api/plans/occurrences: the two calendar
  // reads must fail together, so the helper owns the precedence and caps.
  const window = parseWindow(sp, todayLocal(), {
    fromDefault: "required",
    toDefaultDays: null,
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
  const transactions = queryCalendarTransactions(
    session.uid,
    { from: window.from, to: window.to },
    account.value
  )
  return NextResponse.json({ transactions })
}
