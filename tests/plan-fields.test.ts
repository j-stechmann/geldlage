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
import { PLAN_STATUSES } from "@/lib/contracts/planning"

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
  it("accepts exactly the shared status vocabulary", () => {
    for (const value of PLAN_STATUSES) {
      expect(isPlanStatus(value)).toBe(true)
    }
    for (const value of ["", "all", "ACTIVE", "archived", null, undefined, 1]) {
      expect(isPlanStatus(value)).toBe(false)
    }
  })
})

describe("PLAN_FIELDS metadata", () => {
  it("declares an error code for every field and a cap for every text field", () => {
    for (const spec of PLAN_FIELDS) {
      expect(spec.errorCode).not.toBe("")
      if (spec.kind === "text") {
        expect(spec.maxBytes).toBeGreaterThan(0)
      } else {
        expect("maxBytes" in spec).toBe(false)
      }
    }
  })
})
