import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import type { Db } from "@/lib/db"
import {
  accounts,
  categories,
  plannedTransactions,
  transactions,
} from "@/lib/db/schema"
import { GET as getPlans, POST as postPlanRoute } from "@/app/api/plans/route"
import {
  PATCH as patchPlanRoute,
  DELETE as deletePlanRoute,
} from "@/app/api/plans/[id]/route"
import { GET as getOccurrencesRoute } from "@/app/api/plans/occurrences/route"
import { GET as getForecastRoute } from "@/app/api/plans/forecast/route"
import { GET as getCalendarRoute } from "@/app/api/transactions/calendar/route"
import { GET as getTransactionsRoute } from "@/app/api/transactions/route"
import { todayLocal } from "@/lib/analytics/date"
import { authedRequest, setupTestDb, seedUser } from "./helpers"

const BASE = "http://localhost:3000"
const IBAN = "DE02120300000000202051"

let db: Db
let userId: number
let otherUserId: number
let accountId: number
let categoryId: number

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  otherUserId = seedUser(db, "user-2")
  accountId = db
    .insert(accounts)
    .values({ userId, iban: IBAN, name: "Girokonto" })
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

// helpers invoke the route handlers (labels-api.test.ts pattern) and return
// their responses
function postPlan(url: string, body: unknown, uid: number = userId) {
  return authedRequest(url, uid, { method: "POST", body }).then(postPlanRoute)
}
function patchPlan(id: string, body: unknown, uid: number = userId) {
  return authedRequest(`${BASE}/api/plans/${id}`, uid, {
    method: "PATCH",
    body,
  }).then((req) => patchPlanRoute(req, { params: Promise.resolve({ id }) }))
}
function deletePlan(id: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/plans/${id}`, uid, {
    method: "DELETE",
  }).then((req) => deletePlanRoute(req, { params: Promise.resolve({ id }) }))
}
function getPlansRow(uid: number = userId) {
  return authedRequest(`${BASE}/api/plans`, uid).then(getPlans)
}
function getPlansQuery(query: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/plans?${query}`, uid).then(getPlans)
}
function getOccurrences(query: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/plans/occurrences?${query}`, uid).then(
    getOccurrencesRoute
  )
}
function getForecast(query: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/plans/forecast?${query}`, uid).then(
    getForecastRoute
  )
}

function getCalendar(query: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/transactions/calendar?${query}`, uid).then(
    getCalendarRoute
  )
}

function getTransactions(query: string, uid: number = userId) {
  return authedRequest(`${BASE}/api/transactions?${query}`, uid).then(
    getTransactionsRoute
  )
}

function anonRequest(url: string, method = "GET"): NextRequest {
  return new NextRequest(new Request(url, { method }))
}

function getStored(id: string) {
  return db
    .select()
    .from(plannedTransactions)
    .where(eq(plannedTransactions.id, id))
    .get()
}

async function seedSimplePlan(
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const res = await postPlan(`${BASE}/api/plans`, {
    amountCents: -100,
    dtstart: "2026-01-01",
    rrule: null,
    ...overrides,
  })
  expect(res.status).toBe(201)
  return (await res.json()).plan.id
}

describe("POST /api/plans", () => {
  it("401 without a session", async () => {
    const res = await postPlanRoute(anonRequest(`${BASE}/api/plans`, "POST"))
    expect(res.status).toBe(401)
  })

  it("400 on a non-object body", async () => {
    const req = await authedRequest(`${BASE}/api/plans`, userId, {
      method: "POST",
      body: null,
    })
    const res = await postPlanRoute(req)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_body")
  })

  it("validates fields and maps codes", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { dtstart: "2026-01-01", rrule: null, amountCents: 0 },
        "invalid_amount",
      ],
      [
        { dtstart: "2026-01-01", rrule: null, amountCents: 1.5 },
        "invalid_amount",
      ],
      [
        { dtstart: "2026-01-01", rrule: null, amountCents: "100" },
        "invalid_amount",
      ],
      [
        { amountCents: -100, rrule: null, dtstart: "01.01.2026" },
        "invalid_dtstart",
      ],
      [
        // dtstart is not clearable: an explicit null is a 400, not a no-op
        { amountCents: -100, rrule: null, dtstart: null },
        "invalid_dtstart",
      ],
      [
        // year floor: reads expand forward from dtstart with rrule, which
        // has no internal iteration cap — pre-1900 dtstarts are pointless
        // and pathological
        { amountCents: -100, rrule: null, dtstart: "1899-12-31" },
        "invalid_dtstart",
      ],
      [
        { amountCents: -100, dtstart: "2026-01-01", rrule: "FREQ=SECONDLY" },
        "invalid_rrule",
      ],
      [
        {
          amountCents: -100,
          dtstart: "2026-01-01",
          rrule: "FREQ=DAILY;BYHOUR=3",
        },
        "invalid_rrule",
      ],
      [
        {
          amountCents: -100,
          dtstart: "2026-01-01",
          rrule: "FREQ=DAILY;COUNT=0",
        },
        "invalid_rrule",
      ],
      [
        {
          amountCents: -100,
          dtstart: "2026-01-01",
          rrule: "FREQ=DAILY;COUNT=5;UNTIL=20300101T120000Z",
        },
        "invalid_rrule",
      ],
      [
        {
          amountCents: -100,
          dtstart: "2026-01-01",
          rrule: null,
          status: "gehalten",
        },
        "invalid_status",
      ],
      [
        {
          amountCents: -100,
          dtstart: "2026-01-01",
          rrule: null,
          accountId: 9999,
        },
        "account_not_found",
      ],
      [
        {
          amountCents: -100,
          dtstart: "2026-01-01",
          rrule: null,
          categoryId: 9999,
        },
        "category_not_found",
      ],
      [
        // a typo'd key must not silently vanish (the PATCH/POST contract says
        // unknown fields are 400 unknown_field, mirroring the agent tools)
        {
          amountCents: -100,
          dtstart: "2026-01-01",
          rrule: null,
          accountid: accountId,
        },
        "unknown_field",
      ],
    ]
    for (const [body, code] of cases) {
      const res = await postPlan(`${BASE}/api/plans`, body)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe(code)
    }
  })

  it("rejects rules that never occur at/after dtstart", async () => {
    const res = await postPlan(`${BASE}/api/plans`, {
      amountCents: -100,
      dtstart: "2026-01-01",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20250601T120000Z",
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_rrule")
  })

  it("accepts sparse-but-live rules whose first occurrence lies years ahead", async () => {
    // a leap-day yearly plan with dtstart in a non-leap year: the first
    // occurrence (2028-02-29) is ~624 days out — beyond a fixed 400-day
    // check, found by the same bounded ladder nextOccurrenceDate uses
    const leap = await postPlan(`${BASE}/api/plans`, {
      amountCents: -950_00,
      dtstart: "2026-06-15",
      rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
    })
    expect(leap.status).toBe(201)
    expect(getStored((await leap.json()).plan.id)!.rrule).toBe(
      "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"
    )

    // MONTHLY;INTERVAL=100 fires ~8⅓ years out (2034-07-01) — ladder rung 3
    const sparse = await postPlan(`${BASE}/api/plans`, {
      amountCents: -100,
      dtstart: "2026-03-01",
      rrule: "FREQ=MONTHLY;INTERVAL=100;BYMONTHDAY=1",
    })
    expect(sparse.status).toBe(201)
    expect(getStored((await sparse.json()).plan.id)!.rrule).toBe(
      "FREQ=MONTHLY;INTERVAL=100;BYMONTHDAY=1"
    )
  })

  it("accepts a rule whose first occurrence lies beyond the early ladder rungs", async () => {
    // one Gregorian 400-year cycle between consecutive matches (2000 →
    // 2400 leap Feb 29): a fixed ~34,000-day ladder used to wrongly reject
    // this as invalid_rrule and then report "no future dates" for the
    // stored live rule — the ladder's closing rung makes both truthful
    const res = await postPlan(`${BASE}/api/plans`, {
      amountCents: -100,
      dtstart: "2000-02-29",
      rrule: "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29",
    })
    expect(res.status).toBe(201)
    const id = (await res.json()).plan.id
    const data = await (await getPlansRow(userId)).json()
    const plan = data.plans.find((p: { id: string }) => p.id === id)
    expect(plan.nextDueDate).toBe("2400-02-29")
  })

  it("accepts a dtstart at the 1900 floor", async () => {
    const res = await postPlan(`${BASE}/api/plans`, {
      amountCents: -100,
      dtstart: "1900-01-01",
    })
    expect(res.status).toBe(201)
    expect(getStored((await res.json()).plan.id)!.dtstart).toBe("1900-01-01")
  })

  it("accepts a dtstart at the top of the storable range (year-9999 ladder clamp)", async () => {
    // before the clamp the ladder's window ends crossed into year 10000:
    // toISOString()'s extended form ("+010001-…") truncated into Invalid
    // Dates, every rung answered "no occurrence", and a LIVE daily rule on
    // a 9999-06 dtstart was falsely rejected with invalid_rrule
    const res = await postPlan(`${BASE}/api/plans`, {
      amountCents: -100,
      dtstart: "9999-06-15",
      rrule: "FREQ=DAILY;COUNT=3",
    })
    expect(res.status).toBe(201)
    const data = (await (await getPlansRow()).json()) as {
      plans: Array<{ nextDueDate: string | null }>
    }
    expect(data.plans[0].nextDueDate).toBe("9999-06-15")
  })

  it("creates a plan (201) with a canonicalized rrule", async () => {
    const res = await postPlan(`${BASE}/api/plans`, {
      amountCents: -950_00,
      dtstart: "2026-01-01",
      rrule: "freq=monthly;bymonthday=1",
      counterparty: "Mietwerk GmbH",
      purpose: "Miete Januar",
      categoryId,
      accountId,
      notes: "cold rent",
    })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.plan.amountCents).toBe(-950_00)
    expect(data.plan.rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=1")
    expect(data.plan.categoryName).toBe("Miete")
    expect(data.plan.status).toBe("active")
    expect(getStored(data.plan.id)!.rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=1")
  })

  it("stores an empty-string rrule as NULL (one-off)", async () => {
    const res = await postPlan(`${BASE}/api/plans`, {
      amountCents: -100,
      dtstart: "2026-05-02",
      rrule: "   ",
    })
    expect(res.status).toBe(201)
    expect((await res.json()).plan.rrule).toBeNull()
  })
})

describe("GET /api/plans", () => {
  it("lists own plans with nextDueDate; scoped to the caller", async () => {
    await seedSimplePlan({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=10",
      dtstart: "2030-01-01",
    })
    await seedSimplePlan({ status: "finished" })
    const res = await getPlansRow(userId)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.plans).toHaveLength(2)
    const recurring = data.plans.find(
      (p: { rrule: string | null }) => p.rrule !== null
    )
    expect(recurring.nextDueDate).toBe("2030-01-10")
    const finished = data.plans.find(
      (p: { rrule: string | null }) => p.rrule === null
    )
    expect(finished.nextDueDate).toBeNull()

    // user isolation
    const other = await getPlansRow(otherUserId)
    expect((await other.json()).plans).toHaveLength(0)
  })

  it("breaks equal-createdAt ties deterministically on id", async () => {
    // createdAt carries millisecond precision, but two rows written within
    // that one millisecond (bulk seeds) share it — without a unique-column
    // tiebreaker the relative order would depend on the query plan, i.e.
    // shuffle between requests. The id is unique, so id DESC (same direction
    // as the list) closes the tie for good.
    const stamp = "2026-03-01T12:00:00.000Z"
    for (const id of ["plan-a-tie", "plan-b-tie"]) {
      db.insert(plannedTransactions)
        .values({
          id,
          userId,
          amountCents: -100,
          dtstart: "2026-03-01",
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run()
    }
    const res = await getPlansRow(userId)
    expect(res.status).toBe(200)
    expect((await res.json()).plans.map((p: { id: string }) => p.id)).toEqual([
      "plan-b-tie",
      "plan-a-tie",
    ])
  })

  it("searches counterparty, purpose, notes, account and category names", async () => {
    await seedSimplePlan({
      counterparty: "Mietwerk GmbH",
      purpose: "Miete Januar",
      notes: "Dauerauftrag",
      accountId,
      categoryId,
    })
    await seedSimplePlan({
      counterparty: "Stadtwerke",
      purpose: "Abschlag Strom",
      notes: null,
    })

    for (const q of [
      "mietwerk",
      "MIETE JANUAR",
      "dauerauftrag",
      "Girokonto",
      "Miete",
    ]) {
      const res = await getPlansQuery(
        `page=1&pageSize=20&q=${encodeURIComponent(q)}`
      )
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.total).toBe(1)
      expect(data.plans[0].counterparty).toBe("Mietwerk GmbH")
    }

    // category-only match: the loop's "Miete" also appears in the purpose, so
    // it would still pass if the categories join/search were removed
    const categoryOnlyId = db
      .insert(categories)
      .values({
        userId,
        name: "Nebenkosten",
        nameKey: "nebenkosten",
        language: "de",
        origin: "manual",
      })
      .returning()
      .get().id
    await seedSimplePlan({
      counterparty: "Hausverwaltung",
      purpose: "Abschlag",
      categoryId: categoryOnlyId,
    })
    const categoryOnly = await getPlansQuery(`page=1&pageSize=20&q=Nebenkosten`)
    const categoryOnlyData = await categoryOnly.json()
    expect(categoryOnlyData.total).toBe(1)
    expect(categoryOnlyData.plans[0].counterparty).toBe("Hausverwaltung")

    const miss = await getPlansQuery("page=1&pageSize=20&q=Versicherung")
    expect((await miss.json()).total).toBe(0)
  })

  it("folds case for non-ASCII text too", async () => {
    // SQLite's LIKE is case-insensitive for ASCII only; search_fold covers
    // the rest of the alphabet (Ü/Ö/Ä are common in German bank text)
    await seedSimplePlan({ counterparty: "Überweisung Ölwechsel" })
    await seedSimplePlan({ counterparty: "Stadtwerke" })

    const res = await getPlansQuery(
      `page=1&pageSize=20&q=${encodeURIComponent("überweisung ölwechsel")}`
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total).toBe(1)
    expect(data.plans[0].counterparty).toBe("Überweisung Ölwechsel")
  })

  it("treats LIKE metacharacters in the query as literals", async () => {
    await seedSimplePlan({ counterparty: "Zins 2,5 % p.a." })
    await seedSimplePlan({ counterparty: "Zinsgutschrift" })
    await seedSimplePlan({ counterparty: "IBAN_DE02" })
    await seedSimplePlan({ counterparty: "IBANXDE02" })

    // unescaped, "%" would match every plan and "_" any single character
    const percent = await getPlansQuery(
      `page=1&pageSize=20&q=${encodeURIComponent("%")}`
    )
    const percentData = await percent.json()
    expect(percentData.total).toBe(1)
    expect(percentData.plans[0].counterparty).toBe("Zins 2,5 % p.a.")

    const underscore = await getPlansQuery(
      `page=1&pageSize=20&q=${encodeURIComponent("_")}`
    )
    const underscoreData = await underscore.json()
    expect(underscoreData.total).toBe(1)
    expect(underscoreData.plans[0].counterparty).toBe("IBAN_DE02")
  })

  it("skips the per-plan next-date walk when includeNextDue=0", async () => {
    await seedSimplePlan({ counterparty: "A" })

    const withNext = await (await getPlansQuery("includeNextDue=1")).json()
    expect("nextDueDate" in withNext.plans[0]).toBe(true)

    const without = await (await getPlansQuery("includeNextDue=0")).json()
    expect(without.total).toBe(1)
    expect("nextDueDate" in without.plans[0]).toBe(false)
  })

  it("falls back to page 1 for an unsafe page number", async () => {
    await seedSimplePlan({ counterparty: "A" })
    // (page - 1) * pageSize would exceed SQLite's int64 OFFSET range
    const res = await getPlansQuery("page=1000000000000000000&pageSize=20")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.page).toBe(1)
    expect(data.plans).toHaveLength(1)

    // non-positive / non-numeric pages fall back too (paging params are
    // lenient, unlike the strict status allowlist)
    for (const page of ["0", "-3", "abc"]) {
      const fallback = await getPlansQuery(`page=${page}&pageSize=20`)
      expect(fallback.status).toBe(200)
      const fallbackData = await fallback.json()
      expect(fallbackData.page).toBe(1)
      expect(fallbackData.plans).toHaveLength(1)
    }
  })

  it("falls back to page 1 when the OFFSET product leaves the safe range", async () => {
    await seedSimplePlan({ counterparty: "A" })
    // the page itself is a safe integer, but (page - 1) * 100 is not — the
    // OFFSET would be bound as a REAL
    const res = await getPlansQuery(
      `page=${Number.MAX_SAFE_INTEGER}&pageSize=100`
    )
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.page).toBe(1)
    expect(data.plans).toHaveLength(1)
  })

  it("filters by status and paginates with a stable total/pageCount", async () => {
    await seedSimplePlan({ counterparty: "A", status: "active" })
    await seedSimplePlan({ counterparty: "B", status: "paused" })
    await seedSimplePlan({ counterparty: "C", status: "finished" })

    const activeOnly = await getPlansQuery("page=1&pageSize=20&status=active")
    const activeData = await activeOnly.json()
    expect(activeData.total).toBe(1)
    expect(activeData.plans[0].counterparty).toBe("A")

    const first = await getPlansQuery("page=1&pageSize=2")
    const firstData = await first.json()
    expect(firstData.total).toBe(3)
    expect(firstData.page).toBe(1)
    expect(firstData.pageCount).toBe(2)
    expect(firstData.plans).toHaveLength(2)

    const second = await getPlansQuery("page=2&pageSize=2")
    const secondData = await second.json()
    expect(secondData.total).toBe(3)
    expect(secondData.page).toBe(2)
    expect(secondData.pageCount).toBe(2)
    expect(secondData.plans).toHaveLength(1)
    // the two pages do not overlap
    expect(secondData.plans[0].id).not.toBe(firstData.plans[0].id)
    expect(secondData.plans[0].id).not.toBe(firstData.plans[1].id)

    // an in-range page beyond pageCount is not clamped: it honestly returns
    // an empty page and echoes the requested page (the UI follows pageCount)
    const beyond = await getPlansQuery("page=99&pageSize=2")
    const beyondData = await beyond.json()
    expect(beyondData.total).toBe(3)
    expect(beyondData.page).toBe(99)
    expect(beyondData.pageCount).toBe(2)
    expect(beyondData.plans).toHaveLength(0)
  })

  it("rejects an unknown status instead of returning the unfiltered list", async () => {
    await seedSimplePlan({ counterparty: "A", status: "active" })
    const res = await getPlansQuery("page=1&pageSize=20&status=actve")
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_status")

    // absent/empty/"all" mean "all" (the value the client DTO carries when
    // unfiltered, so the API must not reject it)
    for (const query of [
      "page=1&pageSize=20",
      "page=1&pageSize=20&status=",
      "page=1&pageSize=20&status=all",
    ]) {
      const ok = await getPlansQuery(query)
      expect(ok.status).toBe(200)
      expect((await ok.json()).total).toBe(1)
    }
  })

  it("keeps the unpaged full-list contract for existing consumers", async () => {
    await seedSimplePlan({ counterparty: "A", status: "active" })
    await seedSimplePlan({ counterparty: "B", status: "finished" })
    const res = await getPlansRow(userId)
    const data = await res.json()
    expect(data.plans).toHaveLength(2)
    expect(data.total).toBe(2)
    expect(data.page).toBe(1)
    expect(data.pageCount).toBe(1)
  })

  it("applies q/status to the unpaged full list too", async () => {
    await seedSimplePlan({ counterparty: "Mietwerk", status: "active" })
    await seedSimplePlan({ counterparty: "Stadtwerke", status: "finished" })

    const byStatus = await (await getPlansQuery("status=active")).json()
    expect(byStatus.plans).toHaveLength(1)
    expect(byStatus.plans[0].counterparty).toBe("Mietwerk")
    expect(byStatus.total).toBe(1)
    expect(byStatus.page).toBe(1)
    expect(byStatus.pageCount).toBe(1)

    const bySearch = await (await getPlansQuery("q=stadt")).json()
    expect(bySearch.plans).toHaveLength(1)
    expect(bySearch.plans[0].counterparty).toBe("Stadtwerke")
    expect(bySearch.total).toBe(1)
  })

  it("clamps pageSize to 100", async () => {
    for (let i = 0; i < 101; i++) {
      db.insert(plannedTransactions)
        .values({
          userId,
          counterparty: `Plan ${i}`,
          amountCents: -100,
          dtstart: "2026-01-01",
        })
        .run()
    }
    const res = await getPlansQuery("page=1&pageSize=5000")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total).toBe(101)
    expect(data.plans).toHaveLength(100)
    expect(data.pageCount).toBe(2)
  })

  it("401 without a session", async () => {
    const res = await getPlans(anonRequest(`${BASE}/api/plans`))
    expect(res.status).toBe(401)
  })
})

describe("PATCH /api/plans/[id]", () => {
  it("updates fields partially; only provided keys", async () => {
    const id = await seedSimplePlan({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1" })
    const res = await patchPlan(id, { status: "paused" })
    expect(res.status).toBe(200)
    const after = getStored(id)!
    expect(after.status).toBe("paused")
    expect(after.rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=1") // untouched
    expect(after.amountCents).toBe(-100)
    expect(after.updatedAt).not.toBe(after.createdAt)
  })

  it("404 on foreign/unknown plans", async () => {
    const id = await seedSimplePlan()
    const res = await patchPlan(id, { status: "paused" }, otherUserId)
    expect(res.status).toBe(404)
    const unknown = await patchPlan("missing", { status: "paused" })
    expect(unknown.status).toBe(404)
  })

  it("400 on an empty patch instead of a silent updatedAt-only 200", async () => {
    const id = await seedSimplePlan()
    const empty = await patchPlan(id, {})
    expect(empty.status).toBe(400)
    expect((await empty.json()).error).toBe("invalid_plan")
    // nothing was written — the row is byte-identical to creation
    expect(getStored(id)!.updatedAt).toBe(getStored(id)!.createdAt)
  })

  it("400 on dtstart: null (not clearable) and leaves the plan untouched", async () => {
    const id = await seedSimplePlan({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1" })
    const res = await patchPlan(id, { dtstart: null })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_dtstart")
    expect(getStored(id)!.dtstart).toBe("2026-01-01")
  })

  it("400 on unknown fields (typo'd key) instead of a silent partial patch", async () => {
    const id = await seedSimplePlan()
    const res = await patchPlan(id, { status: "paused", accountid: accountId })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("unknown_field")
    // the message names the offender and the allowed vocabulary
    expect(body.message).toContain("accountid")
    expect(body.message).toContain("accountId")
    // nothing was written
    expect(getStored(id)!.status).toBe("active")
    expect(getStored(id)!.updatedAt).toBe(getStored(id)!.createdAt)
  })

  it("validates rrule updates; accepts nulling the rule with a moved dtstart", async () => {
    const id = await seedSimplePlan({ rrule: "FREQ=MONTHLY;BYMONTHDAY=1" })
    const bad = await patchPlan(id, { rrule: "FREQ=HOURLY" })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe("invalid_rrule")

    const res = await patchPlan(id, { rrule: null, dtstart: "2026-02-14" })
    expect(res.status).toBe(200)
    expect(getStored(id)!.rrule).toBeNull()
    expect(getStored(id)!.dtstart).toBe("2026-02-14")
  })
})

describe("DELETE /api/plans/[id]", () => {
  it("deletes own (404 on repeat / foreign)", async () => {
    const id = await seedSimplePlan()
    const res = await deletePlan(id)
    expect(res.status).toBe(200)
    expect((await res.json()).deleted).toBe(true)
    expect(getStored(id)).toBeUndefined()
    expect((await deletePlan(id)).status).toBe(404)

    // foreign users cannot delete (and leak nothing)
    const id2 = await seedSimplePlan()
    const foreign = await deletePlan(id2, otherUserId)
    expect(foreign.status).toBe(404)
    expect(getStored(id2)).toBeDefined()
  })
})

describe("GET /api/plans/occurrences", () => {
  beforeEach(() => {
    db.insert(transactions)
      .values({
        id: "tx-matched",
        userId,
        accountId,
        bookingDate: "2026-11-04",
        status: "Gebucht",
        payer: "Max Mustermann",
        payee: "Mietwerk GmbH",
        type: "Ausgang",
        amountCents: -950_00,
        sourceHash: "h-matched",
      })
      .run()
  })

  async function seedRentPlan() {
    const id = await seedSimplePlan({
      amountCents: -950_00,
      rrule: "FREQ=MONTHLY;BYMONTHDAY=2",
      counterparty: "Mietwerk GmbH",
      categoryId,
    })
    return id
  }

  it("401 without session; 400 on bad windows / accounts", async () => {
    expect(
      (await getOccurrencesRoute(anonRequest(`${BASE}/api/plans/occurrences`)))
        .status
    ).toBe(401)
    expect((await getOccurrences("from=01.01.2026&to=2026-02-01")).status).toBe(
      400
    )
    // non-ISO shapes that previously 500'd: the default-window derivation
    // ran isoDatePlus on the raw `from` BEFORE validating it
    const noDash = await getOccurrences("from=garbage")
    expect(noDash.status).toBe(400)
    expect((await noDash.json()).error).toBe("invalid_window")
    expect((await getOccurrences("from=2026-10")).status).toBe(400)
    expect((await getOccurrences("from=2026-02-01&to=2026-01-01")).status).toBe(
      400
    )
    expect((await getOccurrences("from=2024-01-01&to=2026-01-01")).status).toBe(
      400
    )
    // windows must also stay within ±60 months of TODAY: rrule expansion
    // walks from dtstart occurrence-by-occurrence up to the window start
    // (no seek), so a far window burns CPU linear in that distance per
    // recurring plan — and its width cap cannot even decide such input
    // (isoDatePlus overflows 4-digit ISO near year 9999)
    const farFuture = await getOccurrences("from=2999-01-01&to=2999-02-10")
    expect(farFuture.status).toBe(400)
    expect((await farFuture.json()).error).toBe("window_too_far")
    const farPast = await getOccurrences("from=1900-01-01&to=1900-02-01")
    expect(farPast.status).toBe(400)
    expect((await farPast.json()).error).toBe("window_too_far")
    expect(
      (await getOccurrences("from=2026-01-01&to=2026-02-01&accountId=0")).status
    ).toBe(400)
    // digits-only: parseInt coercion ("12.9" → 12, "12abc" → 12) would
    // silently read a different account than the client asked for
    expect(
      (await getOccurrences("from=2026-01-01&to=2026-02-01&accountId=12.9"))
        .status
    ).toBe(400)
    expect(
      (await getOccurrences("from=2026-01-01&to=2026-02-01&accountId=12abc"))
        .status
    ).toBe(400)
  })

  it("expands occurrences with category + read-time match state", async () => {
    await seedRentPlan()
    const res = await getOccurrences("from=2026-10-01&to=2026-12-31")
    expect(res.status).toBe(200)
    const { occurrences } = await res.json()
    const byDate = new Map(
      (occurrences as Array<{ date: string; [k: string]: unknown }>).map(
        (o) => [o.date, o]
      )
    )
    // rent rule: every month on the 2nd; three occurrences in the window
    expect([...byDate.keys()].sort()).toEqual([
      "2026-10-02",
      "2026-11-02",
      "2026-12-02",
    ])
    // the tx booked 2026-11-04 drifts +2 days from the due date — inside the
    // [−5, +7] window AND exact in amount/counterparty → matched; the other
    // two occurrences stay unmatched
    expect(byDate.get("2026-10-02")!.matched).toBeNull()
    expect(byDate.get("2026-11-02")!.matched).toMatchObject({
      transactionId: "tx-matched",
      bookingDate: "2026-11-04",
      amountCents: -950_00,
    })
    expect(byDate.get("2026-12-02")!.matched).toBeNull()
    expect(byDate.get("2026-10-02")!.categoryName).toBe("Miete")
    expect(byDate.get("2026-10-02")!.planStatus).toBe("active")
  })

  it("keeps paused occurrences visible and matched outside the forecast", async () => {
    await seedSimplePlan({
      dtstart: "2026-11-02",
      amountCents: -950_00,
      rrule: null,
      counterparty: "Mietwerk GmbH",
      status: "paused",
    })
    const res = await getOccurrences("from=2026-11-01&to=2026-11-30")
    expect(res.status).toBe(200)
    const { occurrences } = (await res.json()) as {
      occurrences: Array<{
        date: string
        planStatus: string
        matched: { transactionId: string } | null
      }>
    }
    expect(occurrences).toHaveLength(1)
    // the default (calendar/list) path still includes paused plans AND still
    // matches their booked rows — only the forecast opts out of paused
    expect(occurrences[0]).toMatchObject({
      date: "2026-11-02",
      planStatus: "paused",
      matched: { transactionId: "tx-matched" },
    })
  })

  it("crosses users: another user sees no occurrences", async () => {
    await seedSimplePlan({ dtstart: "2026-01-01" })
    const res = await getOccurrences(
      "from=2026-01-01&to=2026-01-31",
      otherUserId
    )
    expect((await res.json()).occurrences).toHaveLength(0)
  })

  it("resolves occurrence categories user-scoped (does not leak foreign names)", async () => {
    // Enrichment looks categories up with the caller's scope on top of the
    // id — a plan row referencing a FOREIGN category id (only insertable
    // directly against the write-path ownership checks) must not render
    // that foreign category's name/color, but stay "ohne Kategorie"
    const foreignCategoryId = db
      .insert(categories)
      .values({
        userId: otherUserId,
        name: "Fremd-Kategorie",
        nameKey: "fremd-kategorie",
        language: "de",
        origin: "manual",
        color: "#00ff00",
      })
      .returning()
      .get().id
    // direct insert: the service's ownership check would refuse to create
    // this plan (category_not_found) — the row models a pre-existing state
    // the enrichment must not leak through
    db.insert(plannedTransactions)
      .values({
        id: "plan-foreign-category",
        userId,
        amountCents: -100,
        dtstart: "2026-10-02",
        categoryId: foreignCategoryId,
      })
      .run()
    const res = await getOccurrences("from=2026-10-01&to=2026-10-31")
    expect(res.status).toBe(200)
    const { occurrences } = (await res.json()) as {
      occurrences: Array<{
        categoryName: string | null
        categoryColor: string | null
      }>
    }
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]!.categoryName).toBeNull()
    expect(occurrences[0]!.categoryColor).toBeNull()
  })
})

describe("GET /api/transactions/calendar", () => {
  let otherAccountId: number
  beforeEach(() => {
    otherAccountId = db
      .insert(accounts)
      .values({
        userId: otherUserId,
        iban: "DE02500105170137075072962",
        name: "Fremd-Konto",
      })
      .returning()
      .get().id
    db.insert(transactions)
      .values([
        {
          id: "tx-cal-1",
          userId,
          accountId,
          bookingDate: "2026-11-04",
          status: "Gebucht",
          payer: "Max Mustermann",
          payee: "Mietwerk GmbH",
          type: "Ausgang",
          amountCents: -950_00,
          sourceHash: "h-1",
        },
        {
          id: "tx-cal-2",
          userId,
          accountId,
          bookingDate: "2026-11-05",
          status: "Nicht gebucht",
          payer: "Max Mustermann",
          payee: "Mietwerk GmbH",
          type: "Ausgang",
          amountCents: -950_00,
          sourceHash: "h-2",
        },
        {
          id: "tx-cal-3",
          userId,
          accountId,
          bookingDate: "2026-11-06",
          status: "Gebucht",
          payer: "Vermieter X",
          payee: "Max Mustermann",
          type: "Eingang",
          amountCents: +150_00,
          sourceHash: "h-3",
        },
        {
          id: "tx-foreign",
          userId: otherUserId,
          accountId: otherAccountId,
          bookingDate: "2026-11-04",
          status: "Gebucht",
          payer: "Fremd",
          payee: "Fremd GmbH",
          type: "Ausgang",
          amountCents: -123_00,
          sourceHash: "h-f",
        },
      ])
      .run()
  })

  it("401 without session; 400 on bad windows", async () => {
    const anon = await getCalendarRoute(
      anonRequest(`${BASE}/api/transactions/calendar`)
    )
    expect(anon.status).toBe(401)
    expect((await getCalendar("from=01.01.2026&to=2026-02-01")).status).toBe(
      400
    )
    expect((await getCalendar("from=2026-02-01&to=2026-01-01")).status).toBe(
      400
    )
    expect((await getCalendar("from=2024-01-01&to=2026-01-01")).status).toBe(
      400
    )
    expect(
      (await getCalendar("from=2026-01-01&to=2026-02-01&accountId=0")).status
    ).toBe(400)
    // digits-only, same contract as GET /api/plans/occurrences: parseInt
    // coercion would silently read a different account
    expect(
      (await getCalendar("from=2026-01-01&to=2026-02-01&accountId=12.9")).status
    ).toBe(400)
    expect(
      (await getCalendar("from=2026-01-01&to=2026-02-01&accountId=12abc"))
        .status
    ).toBe(400)
    // same far-window contract as GET /api/plans/occurrences: the two
    // /calendar window reads must fail together (the calendar pair shares
    // one ErrorState — a far navigation would otherwise 400 occurrences
    // while bank chips still served beneath it)
    const farFuture = await getCalendar("from=2999-01-01&to=2999-02-10")
    expect(farFuture.status).toBe(400)
    expect((await farFuture.json()).error).toBe("window_too_far")
    const farPast = await getCalendar("from=1900-01-01&to=1900-02-01")
    expect(farPast.status).toBe(400)
    expect((await farPast.json()).error).toBe("window_too_far")
  })

  it("returns booked + pending rows (status verbatim), scoped per user", async () => {
    const res = await getCalendar("from=2026-11-01&to=2026-11-30")
    expect(res.status).toBe(200)
    const { transactions } = await res.json()
    // pending rows HAVE a Buchungsdatum and are included ("in flight"
    // money); the foreign user's row is excluded — nothing else leaks
    expect(
      (transactions as Array<{ id: string }>).map((t) => t.id).sort()
    ).toEqual(["tx-cal-1", "tx-cal-2", "tx-cal-3"])
    const booked = transactions.find((t: { id: string }) => t.id === "tx-cal-1")
    expect(booked).toMatchObject({
      status: "Gebucht",
      counterparty: "Mietwerk GmbH", // payee for Ausgang
      amountCents: -950_00,
    })
    const pending = transactions.find(
      (t: { id: string }) => t.id === "tx-cal-2"
    )
    expect(pending).toMatchObject({
      status: "Nicht gebucht",
      counterparty: "Mietwerk GmbH",
      amountCents: -950_00,
    })
    const inflow = transactions.find((t: { id: string }) => t.id === "tx-cal-3")
    expect(inflow.counterparty).toBe("Vermieter X") // payer for Eingang
  })
})

describe("GET /api/transactions id lookup", () => {
  beforeEach(() => {
    const otherAccountId = db
      .insert(accounts)
      .values({
        userId: otherUserId,
        iban: "DE02500105170137075072962",
        name: "Fremd-Konto",
      })
      .returning()
      .get().id
    db.insert(transactions)
      .values([
        {
          id: "tx-lookup",
          userId,
          accountId,
          bookingDate: "2026-11-04",
          status: "Gebucht",
          payer: "Max Mustermann",
          payee: "Mietwerk GmbH",
          type: "Ausgang",
          amountCents: -950_00,
          sourceHash: "h-lookup",
        },
        {
          id: "tx-lookup-2",
          userId: otherUserId,
          accountId: otherAccountId,
          bookingDate: "2026-11-04",
          status: "Gebucht",
          payer: "Fremd",
          payee: "Fremd GmbH",
          type: "Ausgang",
          amountCents: -123_00,
          sourceHash: "h-lookup-2",
        },
      ])
      .run()
  })

  it("returns exactly the requested row, user-scoped; miss = empty page", async () => {
    const own = await (await getTransactions("id=tx-lookup")).json()
    expect(own.rows).toHaveLength(1)
    expect(own.rows[0]).toMatchObject({
      id: "tx-lookup",
      payee: "Mietwerk GmbH",
      accountName: "Girokonto",
    })
    expect(own.total).toBe(1)

    // a foreign id is an empty page (never a leak)
    const foreign = await (await getTransactions("id=tx-lookup-2")).json()
    expect(foreign.rows).toHaveLength(0)
    expect(foreign.total).toBe(0)

    const unknown = await (await getTransactions("id=nope")).json()
    expect(unknown.rows).toHaveLength(0)

    // without id → regular list semantics return the user's own rows only
    const list = await (await getTransactions("status=all")).json()
    expect(list.rows).toHaveLength(1)
  })
})

describe("GET /api/plans/forecast", () => {
  // safety net: the frozen-clock test below restores Date in `finally`, but a
  // thrown setup line or timeout must never leak fake timers into later tests
  afterEach(() => {
    vi.useRealTimers()
  })

  it("401 without session; 400 on garbage months", async () => {
    expect(
      (await getForecastRoute(anonRequest(`${BASE}/api/plans/forecast`))).status
    ).toBe(401)
    expect((await getForecast("months=abc")).status).toBe(400)
    // digits-only: parseInt coercion would read "12abc" as a 12-month
    // horizon instead of the invalid_months 400 garbage gets
    expect((await getForecast("months=12abc")).status).toBe(400)
    expect((await getForecast("months=12.9")).status).toBe(400)
    expect((await getForecast("months=-1")).status).toBe(400)
    // same digits-only contract as accountId on /plans/occurrences and
    // /transactions/calendar: "12.9" → 12 would silently scope the
    // projection to account 12 instead of answering invalid_account
    expect((await getForecast("accountId=12.9")).status).toBe(400)
    expect((await getForecast("accountId=12abc")).status).toBe(400)
    expect((await getForecast("accountId=-1")).status).toBe(400)
  })

  it("returns the forecast envelope", async () => {
    const res = await getForecast("months=3")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.forecast).toMatchObject({
      withoutSnapshot: expect.any(Boolean),
      monthlyPlanned: expect.any(Array),
      projectedBalance: expect.any(Array),
      plannedCategories: expect.any(Array),
    })
  })

  it("projects active plans only, even when a paused plan shares the date", async () => {
    // freeze the local clock so the seeded dtstart and the route's own
    // todayLocal() cannot disagree across midnight
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0))
    try {
      const today = todayLocal()
      await seedSimplePlan({
        dtstart: today,
        amountCents: -1_000,
        rrule: null,
        status: "active",
      })
      await seedSimplePlan({
        dtstart: today,
        amountCents: -9_000,
        rrule: null,
        status: "paused",
      })

      const res = await getForecast("months=1")
      expect(res.status).toBe(200)
      const { forecast } = (await res.json()) as {
        forecast: {
          monthlyPlanned: unknown
          plannedCategories: unknown
        }
      }
      // computeForecast must scope occurrences to active plans before
      // building the sums: only the active 1.000-cent plan reaches the sums
      // and category shares
      expect(forecast.monthlyPlanned).toEqual([
        {
          month: today.slice(0, 7),
          incomeCents: 0,
          expensesCents: 1_000,
          netCents: -1_000,
        },
      ])
      expect(forecast.plannedCategories).toEqual([
        {
          categoryId: null,
          name: "ohne Kategorie",
          color: null,
          totalCents: 1_000,
          share: 1,
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
