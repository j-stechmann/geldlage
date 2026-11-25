import { describe, it, expect } from "vitest"
import {
  findBookedSelfHealPairs,
  findDbSelfHealPairs,
  matchIncoming,
  sameBankIdentity,
  toDbMatchRow,
  type DbMatchRow,
} from "@/lib/db/match"
import type { ParsedTransactionRow } from "@/lib/csv/parser"
import type { Transaction } from "@/lib/db/schema"

function dbRow(overrides: Partial<DbMatchRow> = {}): DbMatchRow {
  return {
    id: "db-1",
    bookingDate: "2026-02-03",
    valueDate: "2026-02-03",
    status: "Nicht gebucht",
    payer: null,
    payee: "REWE",
    purpose: "Einkauf",
    type: "Ausgang",
    counterpartyIban: "DE02100100123456789001",
    amountCents: -100,
    creditorId: null,
    mandateRef: null,
    customerRef: null,
    sourceHash: "h",
    occurrenceIndex: 0,
    ...overrides,
  }
}

function incRow(
  overrides: Partial<ParsedTransactionRow> = {}
): ParsedTransactionRow {
  return {
    bookingDate: "2026-02-03",
    valueDate: "2026-02-03",
    status: "Gebucht",
    payer: "",
    payee: "REWE",
    purpose: "Einkauf",
    type: "Ausgang",
    counterpartyIban: "DE02100100123456789001",
    amountCents: -100,
    creditorId: "",
    mandateRef: "",
    customerRef: "",
    ...overrides,
  }
}

function dbFromTransaction(id: string, t: ParsedTransactionRow): DbMatchRow {
  const tx: Transaction = {
    id,
    userId: 1,
    accountId: 1,
    batchId: null,
    bookingDate: t.bookingDate,
    valueDate: t.valueDate,
    status: t.status,
    payer: t.payer || null,
    payee: t.payee || null,
    purpose: t.purpose || null,
    type: t.type,
    counterpartyIban: t.counterpartyIban || null,
    amountCents: t.amountCents,
    creditorId: t.creditorId || null,
    mandateRef: t.mandateRef || null,
    customerRef: t.customerRef || null,
    categoryId: null,
    labelStatus: "pending",
    labelAttempts: 0,
    sourceHash: "h",
    occurrenceIndex: 0,
    hashVersion: 1,
    createdAt: "2026-02-03T00:00:00.000Z",
    updatedAt: "2026-02-03T00:00:00.000Z",
  }
  return toDbMatchRow(tx)
}

describe("window boundaries", () => {
  it("matches at exactly +7 days", () => {
    const db = [
      dbRow({
        id: "p1",
        bookingDate: "2026-02-01",
        counterpartyIban: "DE02100100123456789001",
      }),
    ]
    const inc = [incRow({ bookingDate: "2026-02-08" })]
    const res = matchIncoming(db, inc)
    expect(res.upgrades).toEqual([{ incomingIndex: 0, dbId: "p1" }])
  })

  it("matches at exactly -7 days", () => {
    const db = [
      dbRow({
        id: "p1",
        bookingDate: "2026-02-08",
      }),
    ]
    const inc = [incRow({ bookingDate: "2026-02-01" })]
    const res = matchIncoming(db, inc)
    expect(res.upgrades).toEqual([{ incomingIndex: 0, dbId: "p1" }])
  })

  it("does not match at 8 days", () => {
    const db = [dbRow({ id: "p1", bookingDate: "2026-02-01" })]
    const inc = [incRow({ bookingDate: "2026-02-09" })]
    const res = matchIncoming(db, inc)
    expect(res.upgrades).toEqual([])
    expect(res.refreshes).toEqual([])
    expect(res.skips).toEqual([])
  })
})

describe("party key matching", () => {
  it("matches via equal non-empty IBAN", () => {
    const db = [dbRow({ id: "p1", counterpartyIban: "DE99" })]
    const inc = [incRow({ counterpartyIban: "DE99" })]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(1)
  })

  it("does not match when IBANs differ", () => {
    const db = [dbRow({ id: "p1", counterpartyIban: "DE99" })]
    const inc = [incRow({ counterpartyIban: "DE11" })]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(0)
  })

  it("does not match on empty IBAN alone (both empty)", () => {
    const db = [dbRow({ id: "p1", counterpartyIban: null })]
    const inc = [incRow({ counterpartyIban: "" })]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(0)
  })

  it("falls back to equal non-empty creditorId when IBANs are empty", () => {
    const db = [
      dbRow({
        id: "p1",
        counterpartyIban: null,
        creditorId: "DE98ZZZ09999999999",
      }),
    ]
    const inc = [
      incRow({ counterpartyIban: "", creditorId: "DE98ZZZ09999999999" }),
    ]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(1)
  })

  it("does not match when creditorIds differ", () => {
    const db = [
      dbRow({
        id: "p1",
        counterpartyIban: null,
        creditorId: "DE98ZZZ09999999999",
      }),
    ]
    const inc = [
      incRow({ counterpartyIban: "", creditorId: "DE98ZZZ00000000001" }),
    ]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(0)
  })

  it("falls back to equal non-empty mandateRef when IBAN and creditorId are empty", () => {
    const db = [
      dbRow({
        id: "p1",
        counterpartyIban: null,
        creditorId: null,
        mandateRef: "MREF-123",
      }),
    ]
    const inc = [
      incRow({
        counterpartyIban: "",
        creditorId: "",
        mandateRef: "MREF-123",
      }),
    ]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(1)
  })

  it("does not match when all party keys are unset on either side", () => {
    const db = [
      dbRow({
        id: "p1",
        counterpartyIban: null,
        creditorId: null,
        mandateRef: null,
      }),
    ]
    const inc = [
      incRow({
        counterpartyIban: "",
        creditorId: "",
        mandateRef: "",
      }),
    ]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(0)
  })

  it("does not match when one side has only empty keys", () => {
    const db = [
      dbRow({
        id: "p1",
        counterpartyIban: null,
        creditorId: "CRED",
        mandateRef: null,
      }),
    ]
    const inc = [
      incRow({ counterpartyIban: "", creditorId: "", mandateRef: "" }),
    ]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(0)
  })
})

describe("amount/type discipline", () => {
  it("does not match different amounts", () => {
    const db = [dbRow({ id: "p1" })]
    const inc = [incRow({ amountCents: -200 })]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(0)
  })

  it("does not match different types", () => {
    const db = [dbRow({ id: "p1", type: "Ausgang" })]
    const inc = [incRow({ type: "Eingang", amountCents: 100 })]
    expect(matchIncoming(db, inc).upgrades).toHaveLength(0)
  })
})

describe("classification paths", () => {
  it("upgrade: incoming Gebucht matches DB Nicht gebucht", () => {
    const db = [dbRow({ id: "p1", status: "Nicht gebucht" })]
    const inc = [incRow({ status: "Gebucht" })]
    const res = matchIncoming(db, inc)
    expect(res.upgrades).toEqual([{ incomingIndex: 0, dbId: "p1" }])
    expect(res.refreshes).toEqual([])
    expect(res.skips).toEqual([])
  })

  it("skip: incoming Nicht gebucht matches DB Gebucht", () => {
    const db = [dbRow({ id: "b1", status: "Gebucht" })]
    const inc = [incRow({ status: "Nicht gebucht" })]
    const res = matchIncoming(db, inc)
    expect(res.skips).toEqual([{ incomingIndex: 0, dbId: "b1" }])
    expect(res.upgrades).toEqual([])
    expect(res.refreshes).toEqual([])
  })

  it("refresh: incoming Nicht gebucht differs from DB Nicht gebucht", () => {
    const db = [
      dbRow({ id: "p1", status: "Nicht gebucht", bookingDate: "2026-02-01" }),
    ]
    const inc = [incRow({ status: "Nicht gebucht", bookingDate: "2026-02-02" })]
    const res = matchIncoming(db, inc)
    expect(res.refreshes).toEqual([{ incomingIndex: 0, dbId: "p1" }])
    expect(res.upgrades).toEqual([])
    expect(res.skips).toEqual([])
  })

  it("equal-content pending pairs are NOT returned (tier 1 handles them)", () => {
    const db = [dbRow({ id: "p1", status: "Nicht gebucht" })]
    const inc = [incRow({ status: "Nicht gebucht" })]
    const res = matchIncoming(db, inc)
    expect(res.refreshes).toEqual([])
    expect(res.upgrades).toEqual([])
    expect(res.skips).toEqual([])
  })

  it("does not propose matches between two booked rows (tier 1 owns that)", () => {
    const db = [dbRow({ id: "b1", status: "Gebucht" })]
    const inc = [incRow({ status: "Gebucht" })]
    const res = matchIncoming(db, inc)
    expect(res).toEqual({
      upgrades: [],
      refreshes: [],
      skips: [],
    })
  })
})

describe("greedy 1:1 pairing", () => {
  it("two identical incoming rows vs one DB row → only one pair", () => {
    const db = [dbRow({ id: "p1" })]
    const inc = [incRow(), incRow({ bookingDate: "2026-02-04" })]
    const res = matchIncoming(db, inc)
    expect(res.upgrades).toEqual([{ incomingIndex: 0, dbId: "p1" }])
  })

  it("two DB rows vs one incoming row → closest date wins", () => {
    const db = [
      dbRow({ id: "p1", bookingDate: "2026-02-01" }),
      dbRow({
        id: "p2",
        bookingDate: "2026-02-05",
        counterpartyIban: "DE02100100123456789001",
      }),
    ]
    const inc = [incRow({ status: "Nicht gebucht", bookingDate: "2026-02-06" })]
    const res = matchIncoming(db, inc)
    expect(res.refreshes).toEqual([{ incomingIndex: 0, dbId: "p2" }])
    expect(res.upgrades).toEqual([])
  })

  it("each DB row and each incoming row is used at most once", () => {
    const db = [dbRow({ id: "p1" }), dbRow({ id: "p2" })]
    const inc = [incRow(), incRow({ bookingDate: "2026-02-05" })]
    const res = matchIncoming(db, inc)
    const dbIds = res.upgrades.map((u) => u.dbId).sort()
    const incIdx = res.upgrades.map((u) => u.incomingIndex).sort()
    expect(dbIds).toEqual(["p1", "p2"])
    expect(incIdx).toEqual([0, 1])
  })

  it("closest-date candidate wins when amounts/id tie", () => {
    const db = [
      dbRow({ id: "p1", bookingDate: "2026-02-06" }),
      dbRow({ id: "p2", bookingDate: "2026-02-03" }),
    ]
    const inc = [incRow({ bookingDate: "2026-02-06" })]
    const res = matchIncoming(db, inc)
    expect(res.upgrades).toEqual([{ incomingIndex: 0, dbId: "p1" }])
  })

  it("tie-break determinism: same diff → earliest bookingDate wins", () => {
    const db = [
      dbRow({
        id: "p1",
        bookingDate: "2026-02-05",
        counterpartyIban: "DE02100100123456789002",
      }),
      dbRow({ id: "p2", bookingDate: "2026-02-01" }),
    ]
    const inc = [
      incRow({
        bookingDate: "2026-02-03",
        counterpartyIban: "DE02100100123456789001",
      }),
    ]
    const res = matchIncoming(db, inc)
    expect(res.upgrades).toEqual([{ incomingIndex: 0, dbId: "p2" }])
  })
})

describe("self-heal pairing", () => {
  it("finds a pending row matching a booked row", () => {
    const rows = [
      dbRow({ id: "p1", status: "Nicht gebucht" }),
      dbRow({ id: "b1", status: "Gebucht" }),
    ]
    expect(findDbSelfHealPairs(rows)).toEqual([
      { pendingId: "p1", bookedId: "b1" },
    ])
  })

  it("no self-heal among two pending rows or two booked rows", () => {
    const rows = [
      dbRow({ id: "p1", status: "Nicht gebucht" }),
      dbRow({
        id: "p2",
        status: "Nicht gebucht",
        counterpartyIban: "DE02100100123456789002",
      }),
    ]
    expect(findDbSelfHealPairs(rows)).toEqual([])
    const rows2 = [
      dbRow({ id: "a", status: "Gebucht" }),
      dbRow({
        id: "b",
        status: "Gebucht",
        counterpartyIban: "DE02100100123456789002",
      }),
    ]
    expect(findDbSelfHealPairs(rows2)).toEqual([])
  })

  it("two pending rows vs one booked row → only closest pending deleted", () => {
    const rows = [
      dbRow({ id: "p1", status: "Nicht gebucht", bookingDate: "2026-02-06" }),
      dbRow({ id: "p2", status: "Nicht gebucht", bookingDate: "2026-02-03" }),
      dbRow({ id: "b1", status: "Gebucht", bookingDate: "2026-02-03" }),
    ]
    expect(findDbSelfHealPairs(rows)).toEqual([
      { pendingId: "p2", bookedId: "b1" },
    ])
  })

  it("one pending vs two booked rows → bookedId winner is the closest", () => {
    const rows = [
      dbRow({ id: "p1", status: "Nicht gebucht", bookingDate: "2026-02-03" }),
      dbRow({ id: "b1", status: "Gebucht", bookingDate: "2026-02-05" }),
      dbRow({ id: "b2", status: "Gebucht", bookingDate: "2026-02-03" }),
    ]
    expect(findDbSelfHealPairs(rows)).toEqual([
      { pendingId: "p1", bookedId: "b2" },
    ])
  })

  it("booked row on a different account shape: no false pairing", () => {
    const rows = [
      dbRow({
        id: "p1",
        status: "Nicht gebucht",
        counterpartyIban: "DE02100100123456789001",
        amountCents: -100,
      }),
      dbRow({
        id: "b1",
        status: "Gebucht",
        counterpartyIban: "DE02100100123456789001",
        amountCents: -5000,
      }),
    ]
    expect(findDbSelfHealPairs(rows)).toEqual([])
  })
})

describe("bank identity (Kundenreferenz)", () => {
  const ref = {
    customerRef: "386238826586486",
    counterpartyIban: "DE96120300009005290904",
  }

  it("same ref + amount + type + close date is the same bank transaction", () => {
    const a = { ...incRow(), ...ref }
    const b = { ...incRow({ payee: "EDEKA" }), ...ref }
    expect(sameBankIdentity(a, b)).toBe(true)
  })

  it("same ref but different amount is NOT the same", () => {
    const a = { ...incRow(), ...ref }
    const b = { ...incRow({ amountCents: -200 }), ...ref }
    expect(sameBankIdentity(a, b)).toBe(false)
  })

  it("different refs are never the same", () => {
    const a = { ...incRow(), ...ref }
    const b = incRow({ customerRef: "other" })
    expect(sameBankIdentity(a, b)).toBe(false)
  })

  it("missing refs are never the same", () => {
    const a = incRow()
    const b = incRow()
    expect(sameBankIdentity(a, b)).toBe(false)
  })

  it("booked↔booked re-render (same ref, different payee) is a skip", () => {
    const db = [
      dbRow({
        id: "b1",
        status: "Gebucht",
        payee: "EDEKA",
        ...ref,
      }),
    ]
    const inc = [
      incRow({ status: "Gebucht", payee: "EDEKA.SCHROT/ELXLEBEN", ...ref }),
    ]
    const res = matchIncoming(db, inc)
    expect(res.skips).toEqual([{ incomingIndex: 0, dbId: "b1" }])
    expect(res.upgrades).toEqual([])
    expect(res.refreshes).toEqual([])
  })

  it("identical-content booked↔booked stays with tier 1 (no skip)", () => {
    const db = [dbRow({ id: "b1", status: "Gebucht", ...ref })]
    const inc = [incRow({ status: "Gebucht", ...ref })]
    const res = matchIncoming(db, inc)
    expect(res.skips).toEqual([])
  })

  it("booked↔booked with different refs does not match", () => {
    const db = [dbRow({ id: "b1", status: "Gebucht", customerRef: "ref-1" })]
    const inc = [incRow({ status: "Gebucht", customerRef: "ref-2" })]
    const res = matchIncoming(db, inc)
    expect(res.skips).toEqual([])
  })
})

describe("findBookedSelfHealPairs", () => {
  const ref = { customerRef: "484095562717841", counterpartyIban: null }
  const sameDay = { bookingDate: "2024-04-05" }

  function createdAt(id: string, when: string): Map<string, string> {
    return new Map([[id, when]])
  }

  it("newer re-rendered copy is deleted, older kept", () => {
    const rows = [
      dbRow({
        id: "old",
        status: "Gebucht",
        payee: "EDEKA.SCHROT/ELXLEBEN",
        ...ref,
        ...sameDay,
      }),
      dbRow({
        id: "new",
        status: "Gebucht",
        payee: "EDEKA",
        ...ref,
        ...sameDay,
      }),
    ]
    const times = createdAt("old", "2025-12-21T00:00:00Z").set(
      "new",
      "2026-08-27T00:00:00Z"
    )
    expect(findBookedSelfHealPairs(rows, times)).toEqual([
      expect.objectContaining({ keepId: "old", deleteId: "new" }),
    ])
  })

  it("no pairs when content is identical (tier-1 territory)", () => {
    const rows = [
      dbRow({ id: "a", status: "Gebucht", ...ref, ...sameDay }),
      dbRow({ id: "b", status: "Gebucht", ...ref, ...sameDay }),
    ]
    const times = createdAt("a", "2025-12-21T00:00:00Z").set(
      "b",
      "2026-08-27T00:00:00Z"
    )
    expect(findBookedSelfHealPairs(rows, times)).toEqual([])
  })

  it("no pairs when refs differ", () => {
    const rows = [
      dbRow({ id: "a", status: "Gebucht", customerRef: "ref-1", ...sameDay }),
      dbRow({ id: "b", status: "Gebucht", customerRef: "ref-2", ...sameDay }),
    ]
    const times = createdAt("a", "2025-12-21T00:00:00Z").set(
      "b",
      "2026-08-27T00:00:00Z"
    )
    expect(findBookedSelfHealPairs(rows, times)).toEqual([])
  })

  it("recurring debits with the same generic ref on DIFFERENT days stay distinct", () => {
    const rows = [
      dbRow({
        id: "jun",
        status: "Gebucht",
        payee: "RD-Invest Nebendahl und Behrens GbR",
        customerRef: "62",
        counterpartyIban: null,
        bookingDate: "2025-06-04",
        amountCents: -103000,
      }),
      dbRow({
        id: "may",
        status: "Gebucht",
        payee: "RD-Invest GbR Nebendahl & Behrens",
        customerRef: "62",
        counterpartyIban: null,
        bookingDate: "2025-05-02",
        amountCents: -103000,
      }),
    ]
    const times = createdAt("jun", "2026-08-27T00:00:00Z").set(
      "may",
      "2025-12-21T00:00:00Z"
    )
    expect(findBookedSelfHealPairs(rows, times)).toEqual([])
  })

  it("three same-ref same-day rows collapse to the oldest keeper", () => {
    const rows = [
      dbRow({ id: "a", status: "Gebucht", payee: "A", ...ref, ...sameDay }),
      dbRow({ id: "b", status: "Gebucht", payee: "B", ...ref, ...sameDay }),
      dbRow({ id: "c", status: "Gebucht", payee: "C", ...ref, ...sameDay }),
    ]
    const times = createdAt("a", "2025-01-01T00:00:00Z")
      .set("b", "2025-06-01T00:00:00Z")
      .set("c", "2026-01-01T00:00:00Z")
    const res = findBookedSelfHealPairs(rows, times)
    expect(res).toHaveLength(2)
    for (const p of res) expect(p.keepId).toBe("a")
    expect(res.map((p) => p.deleteId).sort()).toEqual(["b", "c"])
  })

  it("rows without createdAt fall back safely (no crash, no action)", () => {
    const rows = [
      dbRow({ id: "a", status: "Gebucht", payee: "A", ...ref, ...sameDay }),
      dbRow({ id: "b", status: "Gebucht", payee: "B", ...ref, ...sameDay }),
    ]
    expect(findBookedSelfHealPairs(rows, new Map())).toEqual([])
  })
})

describe("toDbMatchRow", () => {
  it("round-trips a Transaction into the match shape", () => {
    const inc = incRow()
    const row = dbFromTransaction("tx-1", inc)
    expect(row.id).toBe("tx-1")
    expect(row.counterpartyIban).toBe("DE02100100123456789001")
    expect(row.valueDate).toBe("2026-02-03")
  })

  it("maps null valueDate to empty string", () => {
    const tx = dbRow({ id: "x", valueDate: "" })
    const asTransaction = {
      id: tx.id,
      userId: 1,
      accountId: 1,
      batchId: null,
      bookingDate: tx.bookingDate,
      valueDate: null,
      status: tx.status,
      payer: tx.payer,
      payee: tx.payee,
      purpose: tx.purpose,
      type: tx.type,
      counterpartyIban: tx.counterpartyIban,
      amountCents: tx.amountCents,
      creditorId: tx.creditorId,
      mandateRef: tx.mandateRef,
      customerRef: tx.customerRef,
      categoryId: null,
      labelStatus: "pending" as const,
      labelAttempts: 0,
      sourceHash: "h",
      occurrenceIndex: 0,
      hashVersion: 1,
      createdAt: "2026-02-03T00:00:00.000Z",
      updatedAt: "2026-02-03T00:00:00.000Z",
    }
    expect(toDbMatchRow(asTransaction).valueDate).toBe("")
  })
})
