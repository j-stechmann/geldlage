import { NextRequest, NextResponse } from "next/server"
import { computeForecast, MAX_FORECAST_MONTHS } from "@/lib/planning/service"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Balance + cashflow projection from real booked data and planned
 * occurrences (ADR-0035) — the third analytics scope, deliberately its own
 * endpoint so computeAnalytics and its two-scope invariant stay untouched.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  let months = 12
  const monthsRaw = sp.get("months")
  if (monthsRaw !== null) {
    const n = Number.parseInt(monthsRaw, 10)
    if (!Number.isInteger(n)) {
      return NextResponse.json({ error: "invalid_months" }, { status: 400 })
    }
    months = Math.min(Math.max(n, 1), MAX_FORECAST_MONTHS)
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

  const forecast = computeForecast(session.uid, { months, accountId })
  return NextResponse.json({ forecast })
}
