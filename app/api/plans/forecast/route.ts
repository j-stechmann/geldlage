import { NextRequest, NextResponse } from "next/server"
import { computeForecast } from "@/lib/planning/service"
import { MAX_FORECAST_MONTHS } from "@/lib/planning/limits"
import {
  parseOptionalAccountId,
  parseOptionalClampedInt,
} from "@/lib/api/query"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Balance + cashflow projection from real booked data and planned
 * occurrences of active plans (ADR-0035) — the third analytics scope,
 * deliberately its own endpoint so computeAnalytics and its two-scope
 * invariant stay untouched.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  const months = parseOptionalClampedInt(sp.get("months"), {
    min: 1,
    max: MAX_FORECAST_MONTHS,
    fallback: 12,
  })
  if (!months.ok) {
    return NextResponse.json({ error: "invalid_months" }, { status: 400 })
  }
  const account = parseOptionalAccountId(sp.get("accountId"))
  if (!account.ok) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 })
  }

  const forecast = computeForecast(session.uid, {
    months: months.value,
    accountId: account.value,
  })
  return NextResponse.json({ forecast })
}
