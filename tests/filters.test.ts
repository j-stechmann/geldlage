import { describe, it, expect } from "vitest"
import {
  EMPTY_FILTERS,
  filtersToParams,
  paramsToFilters,
  type TableFilters,
} from "@/lib/filters"

describe("paramsToFilters", () => {
  it("round-trips the serialized filter state", () => {
    const filters: TableFilters = {
      q: "miete",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      type: "Ausgang",
      categoryIds: [3, 7],
      accountId: 2,
      status: "all",
      labelStatus: "pending",
    }
    expect(paramsToFilters(filtersToParams(filters))).toEqual(filters)
  })

  it("ignores unknown or out-of-vocabulary values", () => {
    expect(
      paramsToFilters(
        new URLSearchParams("type=Transfer&status=offen&accountId=abc")
      )
    ).toEqual(EMPTY_FILTERS)
  })

  it("drops shape-valid but impossible dates the API would reject", () => {
    // the same predicate the list routes validate with: a hand-edited or
    // shared URL must not make the client send a value the API answers with
    // 400 invalid_date
    for (const raw of [
      "2026-02-30",
      "2026-13-01",
      "0000-00-10",
      "10000-01-01",
      "not-a-date",
    ]) {
      const parsed = paramsToFilters(new URLSearchParams(`dateFrom=${raw}`))
      expect(parsed.dateFrom).toBeNull()
    }
    expect(
      paramsToFilters(new URLSearchParams("dateTo=2024-02-29")).dateTo
    ).toBe("2024-02-29")
  })
})
