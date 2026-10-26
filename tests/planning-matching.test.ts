import { describe, it, expect } from "vitest"
import {
  matchPlannedOccurrences,
  type MatchCandidate,
  type MatchableOccurrence,
} from "@/lib/planning/matching"

function occ(
  overrides: Partial<MatchableOccurrence> = {}
): MatchableOccurrence {
  return {
    occurrenceKey: "p1::2026-11-01",
    date: "2026-11-01",
    amountCents: -950_00,
    counterparty: "Mietwerk GmbH",
    accountId: 1,
    ...overrides,
  }
}

function tx(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    id: "tx-1",
    bookingDate: "2026-11-01",
    amountCents: -950_00,
    payer: "Max Mustermann",
    payee: "Mietwerk GmbH",
    accountId: 1,
    ...overrides,
  }
}

describe("matchPlannedOccurrences", () => {
  it("pairs the closest booking inside the drift window", () => {
    const matches = matchPlannedOccurrences(
      [occ()],
      [
        tx({ id: "tx-early", bookingDate: "2026-10-28" }),
        tx({ bookingDate: "2026-11-02" }),
      ]
    )
    expect(matches).toEqual([
      { occurrenceKey: "p1::2026-11-01", transactionId: "tx-1" },
    ])
  })

  it("window boundaries: −5 and +7 days match, −6 and +8 do not", () => {
    expect(
      matchPlannedOccurrences([occ()], [tx({ bookingDate: "2026-10-27" })])
    ).toEqual([{ occurrenceKey: "p1::2026-11-01", transactionId: "tx-1" }])
    expect(
      matchPlannedOccurrences([occ()], [tx({ bookingDate: "2026-11-08" })])
    ).toEqual([{ occurrenceKey: "p1::2026-11-01", transactionId: "tx-1" }])
    expect(
      matchPlannedOccurrences([occ()], [tx({ bookingDate: "2026-10-26" })])
    ).toEqual([])
    expect(
      matchPlannedOccurrences([occ()], [tx({ bookingDate: "2026-11-09" })])
    ).toEqual([])
  })

  it("opposite signs never match", () => {
    expect(
      matchPlannedOccurrences([occ()], [tx({ amountCents: 950_00 })])
    ).toEqual([])
  })

  it("amount tolerance: max(5 €, 1 %) — below matches, above does not", () => {
    // plan −950,00 € ⇒ 1 % = 9,50 € ⇒ effective tolerance 950 ct
    // inside the tolerance (94,99 ct deviation? no: 949 ct)
    expect(
      matchPlannedOccurrences([occ()], [tx({ amountCents: -950_00 + 949 })])
    ).toHaveLength(1)
    // exactly at the boundary (950 ct) still matches
    expect(
      matchPlannedOccurrences([occ()], [tx({ amountCents: -950_00 + 950 })])
    ).toHaveLength(1)
    // just outside (951 ct deviation)
    expect(
      matchPlannedOccurrences([occ()], [tx({ amountCents: -950_00 - 951 })])
    ).toEqual([])
  })

  it("1 % relative tolerance scales with the amount", () => {
    // 10.000,00 € plan; 1 % = 100,00 €
    expect(
      matchPlannedOccurrences(
        [occ({ amountCents: -10_000_000 })],
        [tx({ amountCents: -10_000_000 + 100_000 })]
      )
    ).toHaveLength(1)
    expect(
      matchPlannedOccurrences(
        [occ({ amountCents: -10_000_000 })],
        [tx({ amountCents: -10_000_000 + 100_001 })]
      )
    ).toEqual([])
  })

  it("counterparty substring match (case-insensitive) on payer or payee", () => {
    expect(
      matchPlannedOccurrences(
        [occ({ counterparty: "mietwerk" })],
        [tx({ payee: "MIETWERK GmbH" })]
      )
    ).toHaveLength(1)
    expect(
      matchPlannedOccurrences(
        [occ({ counterparty: "mietwerk" })],
        [tx({ payee: "Vermieter AG", payer: "Mietwerk GbR" })]
      )
    ).toHaveLength(1)
    expect(
      matchPlannedOccurrences(
        [occ({ counterparty: "mietwerk" })],
        [tx({ payee: "Vermieter AG" })]
      )
    ).toEqual([])
  })

  it("no counterparty on the plan → amount/date/account decide", () => {
    expect(
      matchPlannedOccurrences(
        [occ({ counterparty: null })],
        [tx({ payer: "Fremd", payee: "Unbekannt" })]
      )
    ).toHaveLength(1)
  })

  it("account restriction: matching account required", () => {
    expect(
      matchPlannedOccurrences([occ({ accountId: 1 })], [tx({ accountId: 2 })])
    ).toEqual([])
    expect(
      matchPlannedOccurrences(
        [occ({ accountId: null })],
        [tx({ accountId: 2 })]
      )
    ).toHaveLength(1)
  })

  it("greedy: each transaction consumed once, leftovers stay unmatched", () => {
    // two identical occurrences, one booking — the earliest occurrence
    // (smallest |offset|) wins; tx-2 is far outside the window for p2
    const matches = matchPlannedOccurrences(
      [
        occ({ occurrenceKey: "p1::2026-11-01", date: "2026-11-01" }),
        occ({ occurrenceKey: "p1::2026-11-02", date: "2026-11-02" }),
      ],
      [tx(), tx({ id: "tx-2", bookingDate: "2026-12-05" })]
    )
    expect(matches).toEqual([
      { occurrenceKey: "p1::2026-11-01", transactionId: "tx-1" },
    ])
  })

  it("greedy prefers the smallest |date offset| over id order", () => {
    const matches = matchPlannedOccurrences(
      [occ()],
      [
        tx({ id: "tx-a", bookingDate: "2026-11-02" }),
        tx({ id: "tx-b", bookingDate: "2026-11-01" }),
      ]
    )
    expect(matches).toEqual([
      { occurrenceKey: "p1::2026-11-01", transactionId: "tx-b" },
    ])
  })

  it("ties on date resolve by amount closeness", () => {
    const matches = matchPlannedOccurrences(
      [occ({ amountCents: -950_00 })],
      [
        // both on the same day; tx-close differs by 1 €, tx-far by 3 €
        tx({ id: "tx-far", amountCents: -953_00 }),
        tx({ id: "tx-close", amountCents: -949_00 }),
      ]
    )
    expect(matches).toEqual([
      { occurrenceKey: "p1::2026-11-01", transactionId: "tx-close" },
    ])
  })
})
