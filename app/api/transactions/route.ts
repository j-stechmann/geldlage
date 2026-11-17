import { NextRequest, NextResponse } from "next/server"
import {
  parseFilters,
  queryTransactionById,
  queryTransactions,
} from "@/lib/analytics/queries"
import { parsePagination } from "@/lib/api/query"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  // precise single-row lookup (deep link from /calendar): short-circuits all
  // filter/pagination handling — a miss is an empty page, never a leak
  const id = sp.get("id")?.trim()
  if (id) {
    return NextResponse.json(queryTransactionById(id, session.uid))
  }

  const filters = parseFilters(sp)
  const { page, pageSize } = parsePagination(sp, {
    defaultPageSize: 25,
    maxPageSize: 100,
  })

  const result = queryTransactions(filters, session.uid, page, pageSize)
  return NextResponse.json(result)
}
