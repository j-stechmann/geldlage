import { NextRequest, NextResponse } from "next/server"
import { parseOptionalAccountId } from "@/lib/api/query"
import { requireSession, unauthorized } from "@/lib/auth/guard"
import {
  computePredictionForecast,
  PredictionScopeError,
} from "@/lib/prediction/forecast"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The chart-facing daily prediction. Always returns the 2-month envelope; a
 * missing/not-yet-trained model falls back to the daily baseline. Training is
 * automatic and never exposed through this route.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const account = parseOptionalAccountId(
    request.nextUrl.searchParams.get("accountId")
  )
  if (!account.ok) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 })
  }
  try {
    const prediction = computePredictionForecast(session.uid, {
      accountId: account.value ?? null,
    })
    return NextResponse.json({ prediction })
  } catch (error) {
    if (error instanceof PredictionScopeError) {
      return NextResponse.json({ error: error.code }, { status: 400 })
    }
    throw error
  }
}
