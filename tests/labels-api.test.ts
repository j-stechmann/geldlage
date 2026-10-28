import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import type { Db } from "@/lib/db"
import {
  accounts,
  categories,
  labelRules,
  plannedTransactions,
  transactions,
} from "@/lib/db/schema"
import { GET as listLabels, POST as createLabel } from "@/app/api/labels/route"
import {
  PATCH as patchLabel,
  DELETE as deleteLabel,
} from "@/app/api/labels/[id]/route"
import { DELETE as deleteRule } from "@/app/api/label-rules/[id]/route"
import { GET as listRules } from "@/app/api/labels/[id]/rules/route"
import { POST as assignLabel } from "@/app/api/transactions/[id]/label/route"
import { authedRequest, seedUser, setupTestDb, TEST_SUBJECT_2 } from "./helpers"

const IBAN = "DE02120300000000202051"

let db: Db
let accountId: number

function jsonReq(
  url: string,
  body: unknown,
  method = "POST"
): Promise<NextRequest> {
  return authedRequest(url, userId, { method, body })
}

function authedGet(url: string): Promise<NextRequest> {
  return authedRequest(url, userId)
}

function authedDelete(url: string): Promise<NextRequest> {
  return authedRequest(url, userId, { method: "DELETE" })
}

function seedTx(
  overrides: Partial<{
    payer: string | null
    payee: string
    counterpartyIban: string | null
    type: string
    labelStatus: string
    categoryId: number | null
  }> = {}
): string {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId,
      bookingDate: "2026-02-03",
      status: "Gebucht",
      payer: "Max Mustermann",
      payee: "Vermieter GmbH",
      counterpartyIban: IBAN,
      type: "Ausgang",
      amountCents: -100,
      sourceHash: `hash-${id}`,
      labelStatus: "pending",
      labelAttempts: 0,
      ...overrides,
    })
    .run()
  return id
}

function getTx(id: string) {
  return db.select().from(transactions).where(eq(transactions.id, id)).get()
}

let userId: number

beforeEach(async () => {
  ;({ db, userId } = setupTestDb())
  accountId = db
    .insert(accounts)
    .values({ userId, iban: IBAN, name: "Girokonto" })
    .returning()
    .get().id
})

describe("GET /api/labels", () => {
  it("lists labels with usageCount, origin and ruleCount", async () => {
    const miete = db
      .insert(categories)
      .values({
        userId,
        name: "Miete",
        nameKey: "miete",
        language: "de",
        origin: "manual",
        usageCount: 3,
      })
      .returning()
      .get()
    // Regression: the correlated subquery must resolve categories.id to the
    // outer table (SQLite would otherwise shadow it with label_rules.id,
    // counting only rules whose row id coincidentally equals the label id).
    // Two rules with distinct rule ids guarantee a non-coincidental count.
    db.insert(labelRules)
      .values([
        {
          userId,
          labelId: miete.id,
          payer: "Max Mustermann",
          payee: "Vermieter GmbH",
          counterpartyIban: IBAN,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          userId,
          labelId: miete.id,
          payer: "Max Mustermann",
          payee: "Vermieter GmbH",
          counterpartyIban: "DE02500105170137075072962",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])
      .run()

    const res = await listLabels(await authedGet("http://test/api/labels"))
    const data = (await res.json()) as {
      labels: Array<{
        id: number
        name: string
        origin: string
        usageCount: number
        ruleCount: number
      }>
    }
    expect(res.status).toBe(200)
    expect(data.labels).toHaveLength(1)
    expect(data.labels[0]).toMatchObject({
      name: "Miete",
      origin: "manual",
      usageCount: 3,
      ruleCount: 2,
    })
  })
})

describe("POST /api/labels", () => {
  it("creates a manual label", async () => {
    const out = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Lebensmittel" })
    )
    expect(out.status).toBe(201)
    const data = (await out.json()) as { id: number }
    const row = db.select().from(categories).all()[0]
    expect(row.origin).toBe("manual")
    expect(row.nameKey).toBe("lebensmittel")
    expect(data.id).toBe(row.id)
  })

  it("rejects duplicate names with 409", async () => {
    await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const out = await createLabel(
      await jsonReq("http://test/api/labels", { name: "  miete " })
    )
    expect(out.status).toBe(409)
  })

  it("maps a color-index conflict to 500 instead of a false name conflict", async () => {
    // onConflictDoNothing swallows which unique index fired: a racing
    // same-name create leaves a row to reread (→ 409), a color collision
    // caught by the unique index leaves none (→ 500). The trigger
    // reproduces the color-index path without racing a real writer.
    db.run(
      `CREATE TRIGGER simulate_color_race BEFORE INSERT ON categories
       WHEN NEW.color = 'oklch(0.62 0.17 250)'
       BEGIN
         SELECT RAISE(IGNORE);
       END`
    )
    const out = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Farbtest" })
    )
    expect(out.status).toBe(500)
    expect((await out.json()) as { error: string }).toMatchObject({
      error: "insert_failed",
    })
    expect(
      db
        .select()
        .from(categories)
        .where(eq(categories.nameKey, "farbtest"))
        .get()
    ).toBeUndefined()
  })

  it("rejects empty or oversized names with 400", async () => {
    expect(
      (await createLabel(await jsonReq("http://test/api/labels", { name: "" })))
        .status
    ).toBe(400)
    expect(
      (
        await createLabel(
          await jsonReq("http://test/api/labels", { name: "x".repeat(65) })
        )
      ).status
    ).toBe(400)
    // byte cap matches the LLM-side sanitizeLabel limit
    expect(
      (
        await createLabel(
          await jsonReq("http://test/api/labels", { name: "ä".repeat(64) })
        )
      ).status
    ).toBe(400)
    // control characters would break the model-echo round-trip
    // (sanitizeLabel strips them from model output)
    expect(
      (
        await createLabel(
          await jsonReq("http://test/api/labels", { name: "a\u0007b" })
        )
      ).status
    ).toBe(400)
  })

  it("rejects names the prompt renderer would rewrite with 400", async () => {
    // sanitizeField turns these into different strings in suggested_labels,
    // so the model echo could never map back to the stored nameKey
    for (const name of ["Miete | Nebenkosten", "a<<b", "a>>b", "index=0"]) {
      const out = await createLabel(
        await jsonReq("http://test/api/labels", { name })
      )
      expect(out.status).toBe(400)
      const data = (await out.json()) as { message?: string }
      expect(data.message).toContain("| < > index=")
    }
  })
})

describe("GET /api/labels/[id]/rules", () => {
  it("returns 404 for an unknown label id", async () => {
    const res = await listRules(
      await authedGet("http://x/api/labels/999/rules"),
      { params: Promise.resolve({ id: "999" }) }
    )
    expect(res.status).toBe(404)
  })

  it("returns rules for an existing label", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id } = (await created.json()) as { id: number }
    db.insert(labelRules)
      .values({
        userId,
        labelId: id,
        payer: "Max Mustermann",
        payee: "Vermieter GmbH",
        counterpartyIban: IBAN,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    const res = await listRules(
      await authedGet(`http://x/api/labels/${id}/rules`),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { rules: Array<{ labelId: number }> }
    expect(data.rules).toHaveLength(1)
    expect(data.rules[0].labelId).toBe(id)
  })
})

describe("PATCH /api/labels/[id]", () => {
  it("renames and flips origin to manual", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Alt" })
    )
    const { id } = (await created.json()) as { id: number }
    // simulate an llm-invented label
    db.update(categories)
      .set({ origin: "llm" })
      .where(eq(categories.id, id))
      .run()

    const out = await patchLabel(
      await jsonReq(`http://test/api/labels/${id}`, { name: "Neu" }, "PATCH"),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(200)
    const row = db.select().from(categories).all()[0]
    expect(row.name).toBe("Neu")
    expect(row.nameKey).toBe("neu")
    expect(row.origin).toBe("manual")
  })

  it("rejects renames onto an existing nameKey with 409", async () => {
    await createLabel(
      await jsonReq("http://test/api/labels", { name: "Alpha" })
    )
    const b = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Beta" })
    )
    const bData = (await b.json()) as { id: number }

    const out = await patchLabel(
      await jsonReq(
        `http://test/api/labels/${bData.id}`,
        { name: "alpha" },
        "PATCH"
      ),
      { params: Promise.resolve({ id: String(bData.id) }) }
    )
    expect(out.status).toBe(409)
  })

  it("maps a unique-constraint violation on rename to 409", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Alpha" })
    )
    const { id } = (await created.json()) as { id: number }
    // simulate the concurrent-write window: the advisory pre-check passes,
    // then the UPDATE itself hits the unique index (as a racing rename or
    // manual create would). The trigger reproduces the exact violation
    // message better-sqlite3 raises on a real constraint failure.
    db.run(
      `CREATE TRIGGER simulate_rename_race BEFORE UPDATE ON categories
       WHEN NEW.name_key = 'alpha'
       BEGIN
         SELECT RAISE(ABORT, 'UNIQUE constraint failed: categories.name_key');
       END`
    )

    const out = await patchLabel(
      await jsonReq(`http://test/api/labels/${id}`, { name: "Alpha" }, "PATCH"),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(409)
  })

  it("returns 404 for unknown labels", async () => {
    const out = await patchLabel(
      await jsonReq("http://test/api/labels/999", { name: "X" }, "PATCH"),
      {
        params: Promise.resolve({ id: "999" }),
      }
    )
    expect(out.status).toBe(404)
  })
})

describe("DELETE /api/labels/[id]", () => {
  it("resets transactions, cascades rules and deletes the label", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id } = (await created.json()) as { id: number }
    const txId = seedTx({ labelStatus: "labeled" })
    db.update(transactions)
      .set({ categoryId: id })
      .where(eq(transactions.id, txId))
      .run()
    db.insert(labelRules)
      .values({
        userId,
        labelId: id,
        payer: "Max Mustermann",
        payee: "Vermieter GmbH",
        counterpartyIban: IBAN,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    const out = await deleteLabel(
      await authedDelete(`http://x/api/labels/${id}`),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(200)
    const data = (await out.json()) as { affected: number }
    expect(data.affected).toBe(1)

    expect(db.select().from(categories).all()).toHaveLength(0)
    expect(db.select().from(labelRules).all()).toHaveLength(0)
    const row = getTx(txId)!
    expect(row.categoryId).toBeNull()
    expect(row.labelStatus).toBe("pending")
    expect(row.labelAttempts).toBe(0)
  })

  it("returns 404 for unknown ids", async () => {
    const out = await deleteLabel(
      await authedDelete("http://x/api/labels/999"),
      { params: Promise.resolve({ id: "999" }) }
    )
    expect(out.status).toBe(404)
  })

  it("clears planned_transactions referencing the category (plan FK)", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id } = (await created.json()) as { id: number }
    db.insert(plannedTransactions)
      .values({
        id: "plan-referencing-label",
        userId,
        amountCents: -95_000,
        dtstart: "2026-01-01",
        rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        categoryId: id,
      })
      .run()

    // Regression: planned_transactions.category_id REFERENCES categories(id)
    // without ON DELETE action — deleting a label a plan references must
    // clear the plan reference inside the same transaction, not raise
    // FOREIGN KEY constraint failed as an unhandled 500 (plans have no
    // re-labeling step that could clear it beforehand).
    const out = await deleteLabel(
      await authedDelete(`http://x/api/labels/${id}`),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(200)
    expect(db.select().from(categories).all()).toHaveLength(0)
    const plan = db
      .select()
      .from(plannedTransactions)
      .where(eq(plannedTransactions.id, "plan-referencing-label"))
      .get()
    expect(plan!.categoryId).toBeNull()
  })

  it("clears even a foreign plan's reference (FK safety net, deliberately unscoped)", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id } = (await created.json()) as { id: number }
    const otherUserId = seedUser(
      db,
      TEST_SUBJECT_2,
      "https://other-issuer.example.com"
    )
    // App writes can never produce this row (createPlan/validatePlanInput
    // reject foreign references) — it simulates a foreign plan whose
    // category_id carries the same globally-unique id. The plan-FK cleanup is
    // deliberately NOT user-scoped: it must clear EVERY reference to the id
    // being deleted, or this delete raises FOREIGN KEY constraint failed
    // (unhandled → 500) instead of succeeding.
    db.insert(plannedTransactions)
      .values({
        id: "foreign-plan",
        userId: otherUserId,
        amountCents: -10_000,
        dtstart: "2026-01-01",
        rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
        categoryId: id,
      })
      .run()

    const out = await deleteLabel(
      await authedDelete(`http://x/api/labels/${id}`),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(200)
    expect(db.select().from(categories).all()).toHaveLength(0)
    const plan = db
      .select()
      .from(plannedTransactions)
      .where(eq(plannedTransactions.id, "foreign-plan"))
      .get()
    expect(plan!.categoryId).toBeNull()
  })
})

describe("POST /api/transactions/[id]/label", () => {
  it("assigns an existing label, learns the rule and flips origin", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id: labelId } = (await created.json()) as { id: number }
    const txId = seedTx()

    const out = await assignLabel(
      await jsonReq(`http://test/api/transactions/${txId}/label`, { labelId }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(200)

    const row = getTx(txId)!
    expect(row.categoryId).toBe(labelId)
    expect(row.labelStatus).toBe("labeled")
    expect(row.labelAttempts).toBe(0)

    const cat = db.select().from(categories).all()[0]
    expect(cat.origin).toBe("manual")
    expect(cat.usageCount).toBe(1)

    const rules = db.select().from(labelRules).all()
    expect(rules).toHaveLength(1)
    expect(rules[0].counterpartyIban).toBe(IBAN)
    expect(rules[0].payer).toBe("Max Mustermann")
    expect(rules[0].payee).toBe("Vermieter GmbH")
  })

  it("does not learn a rule when the transaction lacks payer or IBAN", async () => {
    const created = await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id: labelId } = (await created.json()) as { id: number }
    const noPayer = seedTx({ payer: null })
    const noIban = seedTx({ counterpartyIban: null })

    for (const txId of [noPayer, noIban]) {
      const out = await assignLabel(
        await jsonReq(`http://test/api/transactions/${txId}/label`, {
          labelId,
        }),
        { params: Promise.resolve({ id: txId }) }
      )
      expect(out.status).toBe(200)
    }

    expect(db.select().from(labelRules).all()).toHaveLength(0)
  })

  it("creates a new label inline via labelName", async () => {
    const txId = seedTx()
    const out = await assignLabel(
      await jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelName: "Sonstiges",
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(200)
    const cat = db.select().from(categories).all()[0]
    expect(cat.name).toBe("Sonstiges")
    expect(cat.origin).toBe("manual")
  })

  it("allocates a unique color when creating a label inline via labelName", async () => {
    await createLabel(
      await jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const txId = seedTx()
    const out = await assignLabel(
      await jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelName: "Sonstiges",
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(200)

    const cats = db.select().from(categories).all()
    expect(cats).toHaveLength(2)
    expect(cats[0].color).not.toBeNull()
    expect(cats[1].color).not.toBeNull()
    expect(cats[1].color).not.toBe(cats[0].color)
  })

  it("rejects labelName over 64 UTF-8 bytes with 400", async () => {
    const txId = seedTx()
    const out = await assignLabel(
      await jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelName: "ä".repeat(64),
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(400)
  })

  it("rejects labelName with control characters with 400", async () => {
    const txId = seedTx()
    const out = await assignLabel(
      await jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelName: "a\u0007b",
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(400)
  })

  it("rejects labelName the prompt renderer would rewrite with 400", async () => {
    const txId = seedTx()
    const out = await assignLabel(
      await jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelName: "Miete | Nebenkosten",
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(400)
    expect(db.select().from(categories).all()).toHaveLength(0)
  })

  it("returns 404 for unknown transactions and labels", async () => {
    const out = await assignLabel(
      await jsonReq("http://test/api/transactions/missing/label", {
        labelName: "X",
      }),
      { params: Promise.resolve({ id: "missing" }) }
    )
    expect(out.status).toBe(404)

    const txId = seedTx()
    const out2 = await assignLabel(
      await jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelId: 999,
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out2.status).toBe(404)
  })
})

describe("DELETE /api/label-rules/[id]", () => {
  it("removes a learned rule", async () => {
    const catId = db
      .insert(categories)
      .values({ userId, name: "A", nameKey: "a", language: "de" })
      .returning()
      .get().id
    const ruleId = db
      .insert(labelRules)
      .values({
        userId,
        labelId: catId,
        payer: "Max Mustermann",
        payee: "Vermieter GmbH",
        counterpartyIban: IBAN,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning()
      .get().id

    const out = await deleteRule(
      await authedDelete(`http://x/api/label-rules/${ruleId}`),
      { params: Promise.resolve({ id: String(ruleId) }) }
    )
    expect(out.status).toBe(200)
    expect(db.select().from(labelRules).all()).toHaveLength(0)
  })

  it("returns 404 for unknown rules", async () => {
    const out = await deleteRule(
      await authedDelete("http://x/api/label-rules/999"),
      { params: Promise.resolve({ id: "999" }) }
    )
    expect(out.status).toBe(404)
  })
})
