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
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

/**
 * Page number whose OFFSET stays a safe integer. A page that is itself safe
 * can still produce an unsafe `(page - 1) * pageSize` (page ~2^53 with a
 * pageSize > 1), which better-sqlite3 binds as a REAL — an unhandled
 * "datatype mismatch" 500 once that REAL leaves SQLite's int64 range. Keep
 * both the page and the product representable; an unsafe page falls back to
 * 1 (an empty page is still the honest answer for a huge in-range offset).
 */
function safePage(raw: string | null, pageSize: number): number {
  const n = Number.parseInt(raw ?? "", 10)
  if (!Number.isSafeInteger(n) || n <= 0) return 1
  return (n - 1) * pageSize <= Number.MAX_SAFE_INTEGER ? n : 1
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
  const pageSize = Math.min(
    positiveInt(sp.get("pageSize"), DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  )
  const page = safePage(sp.get("page"), pageSize)
  // The full-list lookups (calendar chip → plan row, matched-plan reverse
  // lookup) never read `nextDueDate`, and the per-plan recurrence walk is the
  // expensive part of a list read (docs/planning.md cost note): let them opt
  // out explicitly instead of paying it for every plan.
  const includeNextDue = sp.get("includeNextDue") !== "0"

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
    plans: includeNextDue
      ? result.plans.map((plan) => ({
          ...plan,
          nextDueDate: nextDueDate(plan, today),
        }))
      : result.plans,
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
