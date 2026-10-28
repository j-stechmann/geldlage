import { describe, it, expect, beforeEach } from "vitest"
import type { Db } from "@/lib/db"
import {
  accounts,
  categories,
  plannedTransactions,
  type PlannedTransaction,
} from "@/lib/db/schema"
import { agentSystemPrompt, titlePrompt } from "@/lib/agent/system-prompt"
import {
  PLAN_LIST_MAX,
  create_plan,
  delete_plan,
  list_plans,
  update_plan,
  toolByName,
} from "@/lib/agent/tools"
import { TOOL_RESULT_MAX_CHARS } from "@/lib/agent/window"
import { getPlan } from "@/lib/planning/service"
import { setupTestDb, seedUser } from "./helpers"

let db: Db
let userId: number
let otherUserId: number
let accountId: number
let otherAccountId: number
let categoryId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  otherUserId = seedUser(db, "user-2")
  accountId = db
    .insert(accounts)
    .values({ userId, iban: "DE02120300000000202051", name: "Girokonto" })
    .returning()
    .get().id
  otherAccountId = db
    .insert(accounts)
    .values({ userId: otherUserId, iban: "DE00AA00", name: "Fremdkonto" })
    .returning()
    .get().id
  categoryId = db
    .insert(categories)
    .values({
      userId,
      name: "Miete",
      nameKey: "miete",
      language: "de",
      origin: "manual",
      color: "#ff0000",
    })
    .returning()
    .get().id
})

/** ISO day N days from today (local), same clock the tools compute with. */
function dayFromToday(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

const ctx = (uid: number) => ({ uid })

/**
 * Direct insert seeding: tool tests focus on tool behavior, so rows are
 * arranged deterministically instead of walking the create path. createdAt
 * stays controllable because listPlans orders by it DESC.
 */
function seedPlan(opts: {
  userId: number
  amountCents?: number
  dtstart?: string
  rrule?: string | null
  status?: "active" | "paused" | "finished"
  counterparty?: string | null
  purpose?: string | null
  createdAt?: string
}): PlannedTransaction {
  return db
    .insert(plannedTransactions)
    .values({
      userId: opts.userId,
      amountCents: opts.amountCents ?? -85000,
      dtstart: opts.dtstart ?? dayFromToday(3),
      rrule: "rrule" in opts ? opts.rrule : "FREQ=MONTHLY;BYMONTHDAY=1",
      status: opts.status ?? "active",
      counterparty: opts.counterparty ?? "Mietwerk GmbH",
      purpose: opts.purpose ?? null,
      accountId: null,
      categoryId: null,
      createdAt: opts.createdAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: opts.createdAt ?? "2026-01-01T00:00:00.000Z",
    })
    .returning()
    .get()
}

describe("list_plans", () => {
  it("lists the asking user's plans with computed next_due_date", async () => {
    const futureOneOff = seedPlan({
      userId,
      dtstart: dayFromToday(5),
      rrule: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    seedPlan({
      userId,
      status: "finished",
      createdAt: "2026-01-04T00:00:00.000Z",
    })
    const lapsedOneOff = seedPlan({
      userId,
      dtstart: dayFromToday(-2),
      rrule: null,
      status: "active",
      createdAt: "2026-01-03T00:00:00.000Z",
    })
    seedPlan({ userId: otherUserId }) // foreign row must not leak

    const res = (await list_plans.execute({}, ctx(userId))) as {
      plans: Array<{
        id: string
        status: string
        next_due_date: string | null
        counterparty: string | null
      }>
      total: number
      limited: boolean
    }

    expect(res.total).toBe(3)
    expect(res.limited).toBe(false)
    expect(res.plans).toHaveLength(3)
    // Newest first: the finished plan (04) leads — and gets no next date.
    expect(res.plans[0].status).toBe("finished")
    expect(res.plans[0].next_due_date).toBeNull()
    // Future one-off: next due IS dtstart; lapsed one-off: no future date.
    const byId = new Map(res.plans.map((p) => [p.id, p]))
    expect(byId.get(futureOneOff.id)!.next_due_date).toBe(futureOneOff.dtstart)
    expect(byId.get(lapsedOneOff.id)!.next_due_date).toBeNull()
  })

  it("caps summaries and flags the cut — inside the tool-result cap", async () => {
    const ids: string[] = []
    for (let i = 0; i < PLAN_LIST_MAX + 1; i++) {
      ids.push(
        seedPlan({
          userId,
          counterparty: `Plan ${i + 1}`,
          createdAt: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        }).id
      )
    }
    const res = (await list_plans.execute({}, ctx(userId))) as {
      plans: Array<{ id: string }>
      total: number
      limited: boolean
    }
    expect(res.total).toBe(PLAN_LIST_MAX + 1)
    expect(res.limited).toBe(true)
    expect(res.plans.length).toBeGreaterThan(0)
    expect(res.plans.length).toBeLessThanOrEqual(PLAN_LIST_MAX)
    // The row cap alone is not the bound — the WHOLE payload the executor
    // serializes must fit the per-tool-result cap uncut (a cut would hand
    // the model a broken JSON payload).
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_CHARS
    )
    // The cap keeps the NEWEST plans: the last-seeded (newest) leads and
    // the first-seeded (oldest, March 1) falls off.
    expect(res.plans[0].id).toBe(ids[ids.length - 1])
    expect(res.plans.map((p) => p.id)).not.toContain(ids[0])
  })

  it("padded 60-char texts shrink the list; the payload still fits the cap", async () => {
    const padded =
      "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do ei"
    for (let i = 0; i < PLAN_LIST_MAX; i++) {
      seedPlan({
        userId,
        counterparty: padded,
        purpose: padded,
        createdAt: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      })
    }
    const res = (await list_plans.execute({}, ctx(userId))) as {
      plans: Array<{ counterparty: string; purpose: string | null }>
      total: number
      limited: boolean
    }
    expect(res.total).toBe(PLAN_LIST_MAX)
    expect(res.limited).toBe(true)
    // fewer rows than the row cap (the texts consume the char budget), but
    // the payload stays within the uncut tool result either way
    expect(res.plans.length).toBeLessThan(PLAN_LIST_MAX)
    expect(res.plans.length).toBeGreaterThan(0)
    // the clip keeps surrogate pairs intact, so …≤ 60 chars per cell
    expect(res.plans[0].counterparty).toHaveLength(60)
    expect(JSON.stringify(res).length).toBeLessThanOrEqual(
      TOOL_RESULT_MAX_CHARS
    )
  })

  it("omits notes from summaries (details go through query_data)", async () => {
    seedPlan({ userId })
    const res = (await list_plans.execute({}, ctx(userId))) as {
      plans: Array<Record<string, unknown>>
    }
    expect(res.plans[0]).not.toHaveProperty("notes")
    expect(res.plans[0]).not.toHaveProperty("created_at")
  })

  it("rejects unknown args instead of silently answering the unfiltered list", async () => {
    // a {"status": "active"} filter attempt must NOT come back as "these
    // are your active plans" over ALL plans (same loud unknown-field rule
    // as the write tools)
    seedPlan({ userId })
    await expect(
      list_plans.execute({ status: "active" }, ctx(userId))
    ).rejects.toThrow(/unknown field: status \(list_plans takes no arguments\)/)
    // the rejected call must not have produced a result payload
    expect(db.select().from(plannedTransactions).all().length).toBe(1)
  })

  it("rejects non-object args payloads", async () => {
    await expect(list_plans.execute("active", ctx(userId))).rejects.toThrow(
      "invalid args"
    )
    await expect(list_plans.execute(["active"], ctx(userId))).rejects.toThrow(
      "invalid args"
    )
  })

  it("plain no-args calls stay valid ({}, null, undefined)", async () => {
    seedPlan({ userId })
    for (const args of [{}, null, undefined]) {
      const res = (await list_plans.execute(args, ctx(userId))) as {
        total: number
      }
      expect(res.total).toBe(1)
    }
  })
})

describe("create_plan", () => {
  it("creates a one-off plan and returns the full view", async () => {
    const dtstart = dayFromToday(5)
    const res = (await create_plan.execute(
      { amount_cents: -85000, dtstart },
      ctx(userId)
    )) as {
      plan: {
        id: string
        amount_cents: number
        status: string
        rrule: string | null
        next_due_date: string | null
      }
    }

    expect(res.plan.id).toBeTruthy()
    expect(res.plan.amount_cents).toBe(-85000)
    expect(res.plan.status).toBe("active")
    expect(res.plan.rrule).toBeNull()
    expect(res.plan.next_due_date).toBe(dtstart)
    expect(getPlan(userId, res.plan.id)).not.toBeNull()
  })

  it("creates a recurring plan with account/category names resolved", async () => {
    const res = (await create_plan.execute(
      {
        amount_cents: -120000,
        dtstart: "2026-01-01",
        rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        counterparty: "Vermieter",
        purpose: "Miete",
        account_id: accountId,
        category_id: categoryId,
      },
      ctx(userId)
    )) as {
      plan: {
        account_id: number
        account_name: string | null
        category_name: string | null
        next_due_date: string | null
      }
    }

    expect(res.plan.account_name).toBe("Girokonto")
    expect(res.plan.category_name).toBe("Miete")
    expect(res.plan.next_due_date).not.toBeNull()
  })

  it("rejects invalid amounts, dates, rrules and unknown fields", async () => {
    const d = dayFromToday(1)
    await expect(
      create_plan.execute({ amount_cents: 0, dtstart: d }, ctx(userId))
    ).rejects.toThrow("invalid_amount")
    await expect(
      create_plan.execute({ amount_cents: -12.5, dtstart: d }, ctx(userId))
    ).rejects.toThrow("invalid_amount")
    await expect(
      create_plan.execute(
        { amount_cents: -100, dtstart: "2026-13-01" },
        ctx(userId)
      )
    ).rejects.toThrow("invalid_dtstart")
    await expect(
      create_plan.execute(
        { amount_cents: -100, dtstart: d, rrule: "FREQ=SECONDLY" },
        ctx(userId)
      )
    ).rejects.toThrow("invalid_rrule")
    await expect(
      create_plan.execute(
        { amount_cents: -100, dtstart: d, amounts: -5 },
        ctx(userId)
      )
    ).rejects.toThrow("unknown field: amounts")
  })

  it("rejects another user's account/category references", async () => {
    const d = dayFromToday(1)
    await expect(
      create_plan.execute(
        { amount_cents: -100, dtstart: d, account_id: otherAccountId },
        ctx(userId)
      )
    ).rejects.toThrow("account_not_found")
  })
})

describe("update_plan", () => {
  it("patches only provided fields", async () => {
    const plan = seedPlan({
      userId,
      counterparty: "Alt GmbH",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const res = (await update_plan.execute(
      { id: plan.id, amount_cents: -90000, status: "paused" },
      ctx(userId)
    )) as {
      plan: {
        amount_cents: number
        status: string
        counterparty: string | null
        next_due_date: string | null
      }
    }

    expect(res.plan.amount_cents).toBe(-90000)
    expect(res.plan.status).toBe("paused")
    expect(res.plan.counterparty).toBe("Alt GmbH")
    // Paused plans still expand — a next date stays computed.
    expect(res.plan.next_due_date).not.toBeNull()
    const stored = getPlan(userId, plan.id)!
    expect(stored.amountCents).toBe(-90000)
    expect(stored.updatedAt).not.toBe(plan.createdAt)
  })

  it("clears fields with explicit null and finishes plans", async () => {
    const plan = seedPlan({ userId })
    const res = (await update_plan.execute(
      { id: plan.id, rrule: null, status: "finished", notes: null },
      ctx(userId)
    )) as {
      plan: {
        rrule: string | null
        status: string
        next_due_date: string | null
      }
    }

    expect(res.plan.rrule).toBeNull()
    expect(res.plan.status).toBe("finished")
    expect(res.plan.next_due_date).toBeNull() // finished plans get no date
  })

  it("rejects unknown fields, a bare id patch and other users' ids", async () => {
    const plan = seedPlan({ userId })
    const foreign = seedPlan({ userId: otherUserId })

    await expect(
      update_plan.execute({ id: plan.id, ammount_cents: -1 }, ctx(userId))
    ).rejects.toThrow("unknown field: ammount_cents")
    await expect(
      update_plan.execute({ id: plan.id }, ctx(userId))
    ).rejects.toThrow("at least one field")
    await expect(
      update_plan.execute({ id: foreign.id, status: "paused" }, ctx(userId))
    ).rejects.toThrow("not_found")
    // no-op on the foreign plan — the patch never reached it
    expect(getPlan(otherUserId, foreign.id)!.status).toBe("active")
  })
})

describe("delete_plan", () => {
  it("deletes own plans and reports not_found for foreign/unknown ids", async () => {
    const plan = seedPlan({ userId })
    const foreign = seedPlan({ userId: otherUserId })

    const res = (await delete_plan.execute({ id: plan.id }, ctx(userId))) as {
      deleted: boolean
      id: string
    }
    expect(res).toEqual({ deleted: true, id: plan.id })
    expect(getPlan(userId, plan.id)).toBeNull()

    await expect(
      delete_plan.execute({ id: plan.id }, ctx(userId))
    ).rejects.toThrow("not_found")
    await expect(
      delete_plan.execute({ id: foreign.id }, ctx(userId))
    ).rejects.toThrow("not_found")
    expect(getPlan(otherUserId, foreign.id)).not.toBeNull()
  })

  it("rejects extra args loudly instead of silently deleting", async () => {
    const plan = seedPlan({ userId })

    await expect(
      delete_plan.execute({ id: plan.id, confirm: true }, ctx(userId))
    ).rejects.toThrow("unknown field: confirm (delete_plan takes only id)")
    // the rejection fired BEFORE the service call — nothing was deleted
    expect(getPlan(userId, plan.id)).not.toBeNull()
    const res = (await delete_plan.execute({ id: plan.id }, ctx(userId))) as {
      deleted: boolean
    }
    expect(res.deleted).toBe(true)
  })
})

describe("system prompt integration", () => {
  it("carries the plan rules exactly when the quartet is advertised", () => {
    const withPlans = agentSystemPrompt("de", new Date(), [
      "list_plans",
      "create_plan",
      "update_plan",
      "delete_plan",
    ])
    expect(withPlans).toContain("Pläne (geplante Transaktionen):")
    expect(withPlans).toContain("erfinde niemals eine ID")
    expect(withPlans).toContain("delete_plan löscht endgültig")
    expect(withPlans).toContain("status „finished“")

    const withoutPlans = agentSystemPrompt("de", new Date(), ["calculator"])
    expect(withoutPlans).not.toContain("Pläne (geplante Transaktionen):")
    // Title prompt stays tool-free: never mentions mutating plans.
    expect(titlePrompt("lege die Miete an")).not.toContain("delete_plan")
  })

  it("resolves every advertised plan tool from the registry", () => {
    for (const name of [
      "list_plans",
      "create_plan",
      "update_plan",
      "delete_plan",
    ]) {
      expect(toolByName(name)).toBeDefined()
    }
  })
})
