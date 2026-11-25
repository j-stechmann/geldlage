import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import type { Db } from "@/lib/db"
import { accounts, plannedTransactions } from "@/lib/db/schema"
import { POST as postPlan } from "@/app/api/plans/route"
import {
  PATCH as patchPlan,
  DELETE as deletePlan,
} from "@/app/api/plans/[id]/route"
import { authedRequest, setupTestDb } from "./helpers"

const notify = vi.hoisted(() => ({ notifyPlanChanged: vi.fn() }))
vi.mock("@/lib/prediction/triggers", () => ({
  notifyPlanChanged: notify.notifyPlanChanged,
}))

const BASE = "http://localhost:3000"
let db: Db
let userId: number
let accountId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  notify.notifyPlanChanged.mockReset()
  accountId = db
    .insert(accounts)
    .values({ userId, iban: "DE02120300000000202051", name: "Girokonto" })
    .returning()
    .get().id
})

function planRow(
  id: string,
  extra: Partial<typeof plannedTransactions.$inferInsert> = {}
) {
  return {
    id,
    userId,
    accountId,
    amountCents: -1000,
    dtstart: "2026-03-01",
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  }
}

describe("plan prediction triggers", () => {
  it("notifies after create", async () => {
    const req = await authedRequest(`${BASE}/api/plans`, userId, {
      method: "POST",
      body: { amountCents: -1000, dtstart: "2026-03-01", accountId },
    })
    const res = await postPlan(req)
    expect(res.status).toBe(201)
    expect(notify.notifyPlanChanged).toHaveBeenCalledWith(userId, accountId)
  })

  it("notifies after update for the old and new scope", async () => {
    db.insert(plannedTransactions).values(planRow("plan-1")).run()
    const req = await authedRequest(`${BASE}/api/plans/plan-1`, userId, {
      method: "PATCH",
      body: { amountCents: -2000 },
    })
    const res = await patchPlan(req, {
      params: Promise.resolve({ id: "plan-1" }),
    })
    expect(res.status).toBe(200)
    expect(notify.notifyPlanChanged).toHaveBeenCalledWith(userId, accountId)
    expect(notify.notifyPlanChanged).toHaveBeenCalledTimes(2)
  })

  it("notifies after delete", async () => {
    db.insert(plannedTransactions).values(planRow("plan-2")).run()
    const req = await authedRequest(`${BASE}/api/plans/plan-2`, userId, {
      method: "DELETE",
    })
    const res = await deletePlan(req, {
      params: Promise.resolve({ id: "plan-2" }),
    })
    expect(res.status).toBe(200)
    expect(notify.notifyPlanChanged).toHaveBeenCalledWith(userId, accountId)
  })

  it("does not notify for an unknown plan", async () => {
    const req = await authedRequest(`${BASE}/api/plans/missing`, userId, {
      method: "DELETE",
    })
    const res = await deletePlan(req as NextRequest, {
      params: Promise.resolve({ id: "missing" }),
    })
    expect(res.status).toBe(404)
    expect(notify.notifyPlanChanged).not.toHaveBeenCalled()
  })
})
