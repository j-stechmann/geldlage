import { describe, it, expect, vi } from "vitest"
import { paginate } from "@/lib/pagination"

describe("paginate", () => {
  it("returns the requested slice and the page envelope", () => {
    const pageRows = vi.fn(
      (limit: number, offset: number) => [limit, offset] as unknown as string[]
    )
    const result = paginate({ page: 3, pageSize: 10 }, () => 55, pageRows)

    expect(pageRows).toHaveBeenCalledWith(10, 20)
    expect(result).toEqual({
      items: [10, 20],
      total: 55,
      page: 3,
      pageCount: 6,
    })
  })

  it("keeps pageCount at least 1 for an empty result", () => {
    expect(
      paginate(
        { page: 1, pageSize: 20 },
        () => 0,
        () => []
      )
    ).toEqual({ items: [], total: 0, page: 1, pageCount: 1 })
  })

  it("computes a single page for an exact fit", () => {
    expect(
      paginate(
        { page: 1, pageSize: 20 },
        () => 20,
        () => ["a"]
      ).pageCount
    ).toBe(1)
  })
})
