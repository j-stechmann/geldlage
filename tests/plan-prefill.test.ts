import { describe, it, expect } from "vitest"
import { counterpartyOf } from "@/lib/transactions"
import { planPrefill, planPrefillFromTx } from "@/lib/planning/prefill"
import type { TransactionRow } from "@/lib/contracts/transactions"

const tx: TransactionRow = {
  id: "tx-1",
  bookingDate: "2026-11-04",
  valueDate: "2026-11-05",
  status: "Gebucht",
  payer: "Max Mustermann",
  payee: "Mietwerk GmbH",
  purpose: "Miete November",
  type: "Ausgang",
  counterpartyIban: "DE02120300000000202051",
  amountCents: -95_000,
  creditorId: null,
  mandateRef: null,
  customerRef: null,
  accountId: 1,
  accountName: "Girokonto",
  categoryId: 3,
  categoryName: "Miete",
  categoryColor: "#ff0000",
  labelStatus: "labeled",
}

describe("counterpartyOf", () => {
  it("uses the payee for outgoing rows", () => {
    expect(counterpartyOf(tx)).toBe("Mietwerk GmbH")
  })

  it("uses the payer for incoming rows", () => {
    expect(counterpartyOf({ ...tx, type: "Eingang" })).toBe("Max Mustermann")
  })
})

describe("planPrefill", () => {
  it("maps a movement onto the dialog's prefill shape", () => {
    expect(
      planPrefill({
        amountCents: -1_000,
        counterparty: "Vermieter",
        purpose: "Miete",
        date: "2026-12-01",
        accountId: 2,
        categoryId: null,
      })
    ).toEqual({
      amountCents: -1_000,
      counterparty: "Vermieter",
      purpose: "Miete",
      dtstart: "2026-12-01",
      accountId: 2,
      categoryId: null,
    })
  })

  it("maps a full transaction row (payee + booking date)", () => {
    expect(planPrefillFromTx(tx)).toEqual({
      amountCents: -95_000,
      counterparty: "Mietwerk GmbH",
      purpose: "Miete November",
      dtstart: "2026-11-04",
      accountId: 1,
      categoryId: 3,
    })
  })
})
