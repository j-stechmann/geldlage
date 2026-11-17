import { describe, it, expect } from "vitest"
import {
  isPlanStatus,
  PLAN_AGENT_FIELD_MAP,
  PLAN_AGENT_KEYS,
  PLAN_FIELDS,
  PLAN_INPUT_KEYS,
  planTextLimit,
} from "@/lib/planning/fields"
import { MAX_COUNTERPARTY, MAX_TEXT } from "@/lib/planning/limits"

describe("PLAN_FIELDS", () => {
  it("keeps the REST vocabulary order", () => {
    expect([...PLAN_INPUT_KEYS]).toEqual([
      "amountCents",
      "dtstart",
      "rrule",
      "status",
      "counterparty",
      "purpose",
      "notes",
      "accountId",
      "categoryId",
    ])
  })

  it("keeps the agent message order", () => {
    expect(PLAN_AGENT_KEYS).toEqual([
      "amount_cents",
      "dtstart",
      "rrule",
      "status",
      "counterparty",
      "purpose",
      "account_id",
      "category_id",
      "notes",
    ])
  })

  it("maps every agent key to a REST key", () => {
    expect(new Set(Object.keys(PLAN_AGENT_FIELD_MAP))).toEqual(
      new Set(PLAN_AGENT_KEYS)
    )
    for (const key of Object.values(PLAN_AGENT_FIELD_MAP)) {
      expect(PLAN_INPUT_KEYS.has(key)).toBe(true)
    }
  })
})

describe("planTextLimit", () => {
  it("returns the shared byte caps", () => {
    expect(planTextLimit("counterparty")).toBe(MAX_COUNTERPARTY)
    expect(planTextLimit("purpose")).toBe(MAX_TEXT)
    expect(planTextLimit("notes")).toBe(MAX_TEXT)
  })
})

describe("isPlanStatus", () => {
  it("accepts only the three statuses", () => {
    for (const value of ["active", "paused", "finished"]) {
      expect(isPlanStatus(value)).toBe(true)
    }
    for (const value of ["", "all", "ACTIVE", null, undefined, 1]) {
      expect(isPlanStatus(value)).toBe(false)
    }
  })
})

describe("PLAN_FIELDS metadata", () => {
  it("declares text specs with a byte cap", () => {
    for (const spec of PLAN_FIELDS) {
      if (spec.kind === "text") {
        expect("maxBytes" in spec ? spec.maxBytes : undefined).toBeGreaterThan(
          0
        )
      }
    }
  })
})
