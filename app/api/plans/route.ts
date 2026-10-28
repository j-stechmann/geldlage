import { NextRequest, NextResponse } from "next/server"
import {
  createPlan,
  listPlans,
  nextDueDate,
  PlanValidationError,
} from "@/lib/planning/service"
import { todayLocal } from "@/lib/analytics/date"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const today = todayLocal()
  const plans = listPlans(session.uid).map((plan) => ({
    ...plan,
    nextDueDate: nextDueDate(plan, today),
  }))
  return NextResponse.json({ plans })
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
