import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { eq } from "drizzle-orm"
import type { Db } from "@/lib/db"
import { accounts, importBatches, transactions } from "@/lib/db/schema"
import {
  startImport,
  isImportRunning,
  resetStuckBatches,
  resetFailedLabels,
} from "@/lib/import/pipeline"
import { tick } from "@/lib/labeller/worker"
import { completeDrainedBatches, markRowsFailed } from "@/lib/labeller/service"
import { setupTestDb } from "./helpers"

const ACC_IBAN = "DE02120300000000202051"
const ACC_NAME = "Girokonto"

const CSV_OK = [
  "Girokonto;DE02120300000000202051;",
  "Zeitraum:;01.01.2024 – 31.12.2025;",
  "Kontostand vom 05.01.2024:;5.000,00 €;",
  "",
  "Buchungsdatum;Wertstellung;Status;Zahlungspflichtige*r;Zahlungsempfänger*in;Verwendungszweck;Umsatztyp;IBAN;Betrag (€);Gläubiger-ID;Mandatsreferenz;Kundenreferenz",
  "05.01.24;05.01.24;Gebucht;Ich Selbst;REWE;Einkauf;Ausgang;DE02100100123456789001;-67,53;;;",
].join("\n")

const CSV_ALL_PENDING = CSV_OK.replace(
  "Gebucht;Ich Selbst;REWE",
  "Nicht gebucht;Ich Selbst;REWE"
)

let db: Db
let userId: number
let accountId: number
let batchCounter = 0

function seedBatch(status = "labeling"): string {
  batchCounter++
  const id = `b${batchCounter}`
  db.insert(importBatches)
    .values({ id, userId, fileName: `${id}.csv`, accountId, status })
    .run()
  return id
}

function seedTx(
  batchId: string,
  overrides: Partial<{
    labelStatus: string
    labelAttempts: number
    status: string
  }> = {}
): string {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId,
      batchId,
      bookingDate: "2026-02-03",
      status: "Gebucht",
      payee: "REWE",
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

function getBatch(id: string) {
  return db.select().from(importBatches).where(eq(importBatches.id, id)).get()
}

function stubFetch(handler: (url: string, body: unknown) => Response) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    return handler(url, body)
  })
}

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  accountId = db
    .insert(accounts)
    .values({ userId, iban: ACC_IBAN, name: ACC_NAME })
    .returning()
    .get().id
  const g = globalThis as unknown as {
    __geldlageImportJob?: { running: boolean; currentBatchId: string | null }
  }
  g.__geldlageImportJob = { running: false, currentBatchId: null }
})

/** flush all pending microtasks (the job's promise chain settles in ticks) */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe("startImport job-state handshake", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("resets the running flag after a successful synchronous job", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(() => new Response("{}", { status: 200 }))
    )

    const { batchId } = startImport("a.csv", CSV_OK, userId)

    // job runs synchronously; flag was set before it started and must be
    // cleared again once the promise chain settles
    await flush()
    expect(getBatch(batchId)!.status).toBe("labeling")
    expect(isImportRunning()).toBe(false)
    expect(
      db.select().from(accounts).where(eq(accounts.iban, ACC_IBAN)).get()
    ).not.toBeNull()

    // second import must NOT hit the 409 path; its rows dedupe away, so it
    // completes immediately instead of entering labeling
    const second = startImport("b.csv", CSV_OK, userId)
    expect(getBatch(second.batchId)!.status).toBe("completed")
    await flush()
    expect(isImportRunning()).toBe(false)
  })

  it("resets the running flag after a failed job", async () => {
    const badCsv = CSV_OK.replace("05.01.24;05.01.24;Gebucht", "05.01.24")

    const { batchId } = startImport("bad.csv", badCsv, userId)

    await flush()
    expect(getBatch(batchId)!.status).toBe("failed")
    expect(getBatch(batchId)!.error).toBeTruthy()
    expect(isImportRunning()).toBe(false)
  })

  it("rejects a second import while the first is running", () => {
    // hold the slot: set the flag without a job ever clearing it
    const g = globalThis as unknown as {
      __geldlageImportJob?: { running: boolean }
    }
    if (g.__geldlageImportJob) g.__geldlageImportJob.running = true

    expect(() => startImport("c.csv", CSV_OK, userId)).toThrowError(
      /another import is already in progress/
    )
  })

  it("logs and keeps the failed-batch invariant when the job dies before the batch row exists", async () => {
    // Regression: a session uid with no users row (DB wiped by the
    // multi-user fresh-start migration while the stateless cookie stayed
    // valid) made the very first batch INSERT die on the users FK. The
    // catch's UPDATE then matched 0 rows — silently. The job must at least
    // log loudly (the route-level user check prevents this entirely).
    vi.stubGlobal(
      "fetch",
      stubFetch(() => new Response("{}", { status: 200 }))
    )
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    // a dangling uid: no users row with this id (setupTestDb created one;
    // children go first — the account row holds the FK to users)
    const { users, accounts } = await import("@/lib/db/schema")
    db.delete(accounts).where(eq(accounts.userId, userId)).run()
    db.delete(users).where(eq(users.id, userId)).run()

    const { batchId } = startImport("a.csv", CSV_OK, userId)
    await flush()

    expect(getBatch(batchId)).toBeUndefined() // row never written
    expect(isImportRunning()).toBe(false)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(batchId),
      expect.anything()
    )
  })

  it("completes an all-Nicht-gebucht batch immediately", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(() => new Response("{}", { status: 200 }))
    )

    const { batchId } = startImport("pending.csv", CSV_ALL_PENDING, userId)

    await flush()
    const batch = getBatch(batchId)!
    expect(batch.status).toBe("completed")
    expect(batch.completedAt).not.toBeNull()
    expect(isImportRunning()).toBe(false)
  })

  it("resetStuckBatches fails parsing/importing but not labeling", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(() => new Response("{}", { status: 200 }))
    )

    const { batchId } = startImport("a.csv", CSV_OK, userId)
    await flush()
    const other = seedBatch("importing")
    const labeling = seedBatch("labeling")

    expect(resetStuckBatches()).toBe(1)
    expect(getBatch(other)!.status).toBe("failed")
    expect(getBatch(labeling)!.status).toBe("labeling")
    // the freshly imported batch keeps its labeling state (worker drains it)
    expect(getBatch(batchId)!.status).toBe("labeling")
  })
})

describe("markRowsFailed partial-chunk safety", () => {
  it("does not flip rows a previously applied chunk already labeled", () => {
    const batchId = seedBatch()
    const labeledId = seedTx(batchId)
    const pendingId = seedTx(batchId)

    // first chunk succeeded (applied via onBatchDone), then the second threw
    db.update(transactions)
      .set({ labelStatus: "labeled", labelAttempts: 1 })
      .where(eq(transactions.id, labeledId))
      .run()

    markRowsFailed(
      [labeledId, pendingId],
      new Map([
        [labeledId, 1],
        [pendingId, 0],
      ])
    )

    expect(getTx(labeledId)!.labelStatus).toBe("labeled")
    expect(getTx(pendingId)!.labelStatus).toBe("failed")
  })
})

describe("drain detection with exhausted attempts", () => {
  it("completeDrainedBatches ignores pending rows at the attempts cap", () => {
    const batchId = seedBatch()
    seedTx(batchId, { labelStatus: "pending", labelAttempts: 5 })

    expect(completeDrainedBatches(5)).toBe(1)
    expect(getBatch(batchId)!.status).toBe("completed")
  })

  it("keeps the batch when pending rows still have attempts left", () => {
    const batchId = seedBatch()
    seedTx(batchId, { labelStatus: "pending", labelAttempts: 4 })

    expect(completeDrainedBatches(5)).toBe(0)
    expect(getBatch(batchId)!.status).toBe("labeling")
  })

  it("claims only rows below the cap and never flips already-labeled rows", async () => {
    const batchId = seedBatch()
    const okId = seedTx(batchId, { labelStatus: "failed", labelAttempts: 4 })
    const cappedId = seedTx(batchId, {
      labelStatus: "pending",
      labelAttempts: 5,
    })
    const labeledId = seedTx(batchId, { labelStatus: "labeled" })

    vi.stubGlobal(
      "fetch",
      stubFetch((url, body) => {
        if (url.includes("/health") && !url.includes("chat")) {
          return new Response("{}", { status: 200 })
        }
        const b = body as { messages: Array<{ role: string; content: string }> }
        const userMsg = b.messages.find((m) => m.role === "user")!
        const count = (userMsg.content.match(/^\[\d+\]/gm) ?? []).length
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: Array.from({ length: count }, (_, i) => ({
                      index: i,
                      label: "Lebensmittel",
                    })),
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        )
      })
    )

    await tick()

    expect(getTx(okId)!.labelStatus).toBe("labeled")
    expect(getTx(cappedId)!.labelStatus).toBe("pending")
    expect(getTx(cappedId)!.labelAttempts).toBe(5)
    expect(getTx(labeledId)!.labelStatus).toBe("labeled")
    expect(getBatch(batchId)!.status).toBe("completed")
  })
})

describe("resetFailedLabels revives capped rows", () => {
  it("resets attempts for failed and pending rows at/above the cap", () => {
    const batchId = seedBatch()
    const cappedFailed = seedTx(batchId, {
      labelStatus: "failed",
      labelAttempts: 5,
    })
    const cappedPending = seedTx(batchId, {
      labelStatus: "pending",
      labelAttempts: 7,
    })
    seedTx(batchId, { labelStatus: "failed", labelAttempts: 2 })

    const revived = resetFailedLabels(5, userId)

    expect(revived).toBe(2)
    expect(getTx(cappedFailed)!.labelStatus).toBe("pending")
    expect(getTx(cappedFailed)!.labelAttempts).toBe(0)
    expect(getTx(cappedPending)!.labelStatus).toBe("pending")
    expect(getTx(cappedPending)!.labelAttempts).toBe(0)
  })

  it("leaves rows below the cap untouched (worker self-heals them)", () => {
    const batchId = seedBatch()
    const belowCap = seedTx(batchId, {
      labelStatus: "failed",
      labelAttempts: 2,
    })

    expect(resetFailedLabels(5, userId)).toBe(0)
    expect(getTx(belowCap)!.labelStatus).toBe("failed")
    expect(getTx(belowCap)!.labelAttempts).toBe(2)
  })
})
