import { NextRequest, NextResponse } from "next/server"
import {
  listOccurrences,
  MAX_OCCURRENCE_WINDOW_DAYS,
} from "@/lib/planning/service"
import { isValidIsoDate, isoDatePlus } from "@/lib/planning/recurrence"
import { todayLocal } from "@/lib/analytics/date"
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

  const today = todayLocal()
  const from = sp.get("from") ?? today
  // `from` must be validated BEFORE deriving the default window from it —
  // isoDatePlus throws on non-ISO input (a 500) instead of answering the
  // invalid_window 400 this route promises
  if (!isValidIsoDate(from)) {
    return NextResponse.json(
      { error: "invalid_window", message: "from/to must be ISO dates" },
      { status: 400 }
    )
  }
  const toRaw = sp.get("to") ?? isoDatePlus(from, 89)
  if (!isValidIsoDate(toRaw)) {
    return NextResponse.json(
      { error: "invalid_window", message: "from/to must be ISO dates" },
      { status: 400 }
    )
  }
  if (from > toRaw) {
    return NextResponse.json(
      { error: "invalid_window", message: "from must not be after to" },
      { status: 400 }
    )
  }
  // window cap in days (ISO strings compare lexically, but the cap counts
  // days — a from far behind to is bounded here)
  if (isoDatePlus(from, MAX_OCCURRENCE_WINDOW_DAYS) < toRaw) {
    return NextResponse.json(
      {
        error: "window_too_large",
        message: `window must not exceed ${MAX_OCCURRENCE_WINDOW_DAYS} days`,
      },
      { status: 400 }
    )
  }
  const accountIdRaw = sp.get("accountId")
  let accountId: number | undefined
  if (accountIdRaw !== null) {
    const n = Number.parseInt(accountIdRaw, 10)
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: "invalid_account" }, { status: 400 })
    }
    accountId = n
  }

  const occurrences = listOccurrences(
    session.uid,
    { from, to: toRaw },
    accountId
  )
  return NextResponse.json({ occurrences })
}
