import { NextRequest, NextResponse } from "next/server"
import { parseFilters } from "@/lib/analytics/queries"
import { computeAnalytics } from "@/lib/analytics/engine"
import { todayLocal } from "@/lib/dates"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams
  const filters = parseFilters(sp)
  const result = computeAnalytics(filters, session.uid, todayLocal())
  return NextResponse.json(result)
}
