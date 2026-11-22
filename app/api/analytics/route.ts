import { NextRequest, NextResponse } from "next/server"
import { parseFilters } from "@/lib/analytics/queries"
import {
  MAX_ANALYTICS_DATE,
  MIN_ANALYTICS_DATE,
  parseAnalyticsDate,
} from "@/lib/api/query"
import { computeAnalytics } from "@/lib/analytics/engine"
import { todayLocal } from "@/lib/dates"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  // The engine runs prevMonth/nextMonth over these dates; reject values whose
  // month arithmetic would leave the four-digit month-key range.
  const dateFrom = parseAnalyticsDate(sp.get("dateFrom"))
  const dateTo = parseAnalyticsDate(sp.get("dateTo"))
  if (!dateFrom.ok || !dateTo.ok) {
    return NextResponse.json(
      {
        error: "invalid_date",
        message: `dateFrom/dateTo must be ISO dates between ${MIN_ANALYTICS_DATE} and ${MAX_ANALYTICS_DATE}`,
      },
      { status: 400 }
    )
  }

  const filters = {
    ...parseFilters(sp),
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
  }
  const result = computeAnalytics(filters, session.uid, todayLocal())
  return NextResponse.json(result)
}
