import { NextRequest, NextResponse } from "next/server"
import {
  createPlan,
  listPlans,
  listPlansFiltered,
  listPlansPage,
  nextDueDate,
  PlanValidationError,
} from "@/lib/planning/service"
import type { PlanListFilters } from "@/lib/contracts/planning"
import type { PlanStatus } from "@/lib/db/schema"
import { todayLocal } from "@/lib/dates"
import { parsePagination } from "@/lib/api/query"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/**
 * Strict `status` parsing: absent/empty/`all` = all. An unknown value is
 * rejected (null) instead of silently falling back to the unfiltered list — a
 * typo'd or renamed client value must not read as a successful "all" query.
 * The other planning routes reject malformed query params the same way
 * (invalid_account / invalid_months / invalid_window).
 */
function parseStatus(raw: string | null): PlanStatus | "all" | null {
  if (raw === null || raw === "" || raw === "all") return "all"
  if (raw === "active" || raw === "paused" || raw === "finished") return raw
  return null
}

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams
  const today = todayLocal()

  const status = parseStatus(sp.get("status"))
  if (status === null) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 })
  }
  const filters: PlanListFilters = {
    q: sp.get("q")?.trim() ?? "",
    status,
  }
  const { page, pageSize, paginated } = parsePagination(sp, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
    onlyWhenPresent: true,
  })
  // The full-list lookups (calendar chip → plan row, matched-plan reverse
  // lookup) never read `nextDueDate`, and the per-plan recurrence walk is the
  // expensive part of a list read (docs/planning.md cost note): let them opt
  // out explicitly instead of paying it for every plan.
  const includeNextDue = sp.get("includeNextDue") !== "0"

  // Backward-compatible shape: callers that only need the full list (the
  // calendar's plan lookup and the read-time match reverse lookup) send no
  // paging params and keep receiving every plan.
  const result = paginated
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
