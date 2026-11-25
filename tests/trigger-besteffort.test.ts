import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  DELETE as deleteAccount,
  POST as postAccount,
} from "@/app/api/accounts/route"
import { accounts } from "@/lib/db/schema"
import { POST as postPlan } from "@/app/api/plans/route"
import { authedRequest, setupTestDb } from "./helpers"

vi.mock("@/lib/prediction/scheduler", () => ({
  scheduleAfterAccountDelete: vi.fn(() => {
    throw new Error("db down")
  }),
  scheduleAfterImport: vi.fn(() => {
    throw new Error("db down")
  }),
  scheduleAfterPlanChange: vi.fn(() => {
    throw new Error("db down")
  }),
  schedulePredictionTraining: vi.fn(() => {
    throw new Error("db down")
  }),
}))

import {
  notifyAccountCreated,
  notifyAccountDeleted,
  notifyImportCommitted,
  notifyPlanChanged,
} from "@/lib/prediction/triggers"

describe("prediction trigger best-effort", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("never throws from a failing scheduler", () => {
    expect(() => notifyPlanChanged(1, null)).not.toThrow()
    expect(() => notifyImportCommitted(1, 2)).not.toThrow()
    expect(() => notifyAccountCreated(1, 2)).not.toThrow()
    expect(() => notifyAccountDeleted(1, 2)).not.toThrow()
    expect(console.error).toHaveBeenCalled()
  })

  it("still returns 201 when the account-create trigger throws", async () => {
    const { userId } = setupTestDb()
    const req = await authedRequest(
      "http://localhost:3000/api/accounts",
      userId,
      {
        method: "POST",
        body: { iban: "DE02120300000000202051", name: "Girokonto" },
      }
    )
    const res = await postAccount(req)
    expect(res.status).toBe(201)
    expect(console.error).toHaveBeenCalled()
  })

  it("still returns 200 when the account-delete trigger throws", async () => {
    const { db, userId } = setupTestDb()
    const account = db
      .insert(accounts)
      .values({ userId, iban: "DE02120300000000202051", name: "Girokonto" })
      .returning()
      .get()
    const req = await authedRequest(
      `http://localhost:3000/api/accounts?iban=${account.iban}`,
      userId,
      { method: "DELETE" }
    )
    const res = await deleteAccount(req)
    expect(res.status).toBe(200)
    expect(console.error).toHaveBeenCalled()
  })

  it("still returns 201 when the plan-create trigger throws", async () => {
    const { userId } = setupTestDb()
    const req = await authedRequest("http://localhost:3000/api/plans", userId, {
      method: "POST",
      body: { amountCents: -1000, dtstart: "2026-03-01" },
    })
    const res = await postPlan(req)
    expect(res.status).toBe(201)
    expect(console.error).toHaveBeenCalled()
  })
})
