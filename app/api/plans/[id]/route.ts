import { NextRequest, NextResponse } from "next/server"
import {
  deletePlan,
  getPlan,
  updatePlan,
  PlanValidationError,
} from "@/lib/planning/service"
import { notifyPlanChanged } from "@/lib/prediction/triggers"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  }
  try {
    const before = getPlan(session.uid, id)
    if (!before) {
      return NextResponse.json({ error: "not_found" }, { status: 404 })
    }
    const plan = updatePlan(session.uid, id, body)
    if (!plan) {
      return NextResponse.json({ error: "not_found" }, { status: 404 })
    }
    notifyPlanChanged(session.uid, before.accountId)
    notifyPlanChanged(session.uid, plan.accountId)
    return NextResponse.json({ plan })
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params
  const before = getPlan(session.uid, id)
  if (!before) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  const deleted = deletePlan(session.uid, id)
  if (!deleted) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  notifyPlanChanged(session.uid, before.accountId)
  return NextResponse.json({ deleted: true })
}
