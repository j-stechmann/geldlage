import { NextRequest, NextResponse } from "next/server"
import { parseRouteFilters } from "@/lib/analytics/queries"
import { computeAnalytics } from "@/lib/analytics/engine"
import { MAX_DATE_RANGE_MONTHS, todayLocal } from "@/lib/dates"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  // Shares date *validation* with /api/transactions. The month-span cap is
  // analytics-only: this engine materializes one bucket per month, while the
  // transactions list only binds the dates into SQL.
  const parsed = parseRouteFilters(sp, {
    maxMonths: MAX_DATE_RANGE_MONTHS,
  })
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, message: parsed.message },
      { status: 400 }
    )
  }

  const result = computeAnalytics(parsed.filters, session.uid, todayLocal())
  return NextResponse.json(result)
}
