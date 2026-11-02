import { NextRequest, NextResponse } from "next/server"
import {
  createPlan,
  listPlans,
  listPlansFiltered,
  listPlansPage,
  nextDueDate,
  PlanValidationError,
  type PlanListFilters,
} from "@/lib/planning/service"
import type { PlanStatus } from "@/lib/db/schema"
import { todayLocal } from "@/lib/analytics/date"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

function positiveInt(raw: string | null, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function parseStatus(raw: string | null): PlanStatus | "all" {
  return raw === "active" || raw === "paused" || raw === "finished"
    ? raw
    : "all"
}

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams
  const today = todayLocal()

  const filters: PlanListFilters = {
    q: sp.get("q")?.trim() ?? "",
    status: parseStatus(sp.get("status")),
  }
  const paginate = sp.has("page") || sp.has("pageSize")
  const page = positiveInt(sp.get("page"), 1)
  const pageSize = Math.min(
    positiveInt(sp.get("pageSize"), DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  )

  // Backward-compatible shape: callers that only need the full list (the
  // calendar's plan lookup and the read-time match reverse lookup) send no
  // paging params and keep receiving every plan.
  const result = paginate
    ? listPlansPage(session.uid, filters, page, pageSize)
    : (() => {
        const plans =
          filters.q || filters.status !== "all"
            ? listPlansFiltered(session.uid, filters)
            : listPlans(session.uid)
        return {
          plans,
          total: plans.length,
          page: 1,
          pageCount: 1,
        }
      })()

  return NextResponse.json({
    ...result,
    plans: result.plans.map((plan) => ({
      ...plan,
      nextDueDate: nextDueDate(plan, today),
    })),
  })
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }
  try {
    const plan = createPlan(session.uid, body)
    return NextResponse.json({ plan }, { status: 201 })
  } catch (err) {
    if (err instanceof PlanValidationError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: 400 }
      )
    }
    throw err
  }
}
