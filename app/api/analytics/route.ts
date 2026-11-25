import { NextRequest, NextResponse } from "next/server"
import { parseRouteFilters } from "@/lib/analytics/queries"
import { computeAnalytics } from "@/lib/analytics/engine"
import { todayLocal } from "@/lib/dates"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  // Shares date *validation* with /api/transactions; a span too wide to
  // zero-fill is degraded by the engine (one bucket per populated month), never
  // rejected — the FilterBar lets users pick any range.
  const parsed = parseRouteFilters(sp)
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, message: parsed.message },
      { status: 400 }
    )
  }

  const result = computeAnalytics(parsed.filters, session.uid, todayLocal())
  return NextResponse.json(result)
}
