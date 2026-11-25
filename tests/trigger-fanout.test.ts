import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Db } from "@/lib/db"
import { accounts } from "@/lib/db/schema"
import {
  POST as postAccount,
  DELETE as deleteAccount,
} from "@/app/api/accounts/route"
import { create_plan, update_plan, delete_plan } from "@/lib/agent/tools"
import { authedRequest, setupTestDb } from "./helpers"

const notify = vi.hoisted(() => ({
  notifyPlanChanged: vi.fn(),
  notifyAccountCreated: vi.fn(),
  notifyAccountDeleted: vi.fn(),
  notifyImportCommitted: vi.fn(),
}))
vi.mock("@/lib/prediction/triggers", () => notify)

const BASE = "http://localhost:3000"
let db: Db
let userId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  for (const fn of Object.values(notify)) fn.mockReset()
})

describe("account and agent prediction triggers", () => {
  it("notifies on account create and delete", async () => {
    const post = await authedRequest(`${BASE}/api/accounts`, userId, {
      method: "POST",
      body: { iban: "DE02120300000000202051", name: "Girokonto" },
    })
    const created = await postAccount(post)
    expect(created.status).toBe(201)
    const account = db.select().from(accounts).get()!
    expect(notify.notifyAccountCreated).toHaveBeenCalledWith(userId, account.id)

    const del = await authedRequest(
      `${BASE}/api/accounts?iban=${account.iban}`,
      userId,
      { method: "DELETE" }
    )
    const deleted = await deleteAccount(del)
    expect(deleted.status).toBe(200)
    expect(notify.notifyAccountDeleted).toHaveBeenCalledWith(userId, account.id)
  })

  it("notifies from the agent plan create/update/delete tools", async () => {
    const created = (await create_plan.execute(
      { amount_cents: -1000, dtstart: "2026-03-01" },
      { uid: userId }
    )) as { plan: { id: string } }
    expect(notify.notifyPlanChanged).toHaveBeenCalledWith(userId, null)

    const id = created.plan.id
    await update_plan.execute({ id, amount_cents: -2000 }, { uid: userId })
    expect(notify.notifyPlanChanged).toHaveBeenCalledWith(userId, null)

    await delete_plan.execute({ id }, { uid: userId })
    expect(notify.notifyPlanChanged).toHaveBeenCalledWith(userId, null)
  })
})
