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

  it("echoes a page whose OFFSET is representable (even above 2^53)", () => {
    const pageRows = vi.fn((limit: number, offset: number) => [
      limit,
      offset,
    ] as unknown as string[])
    const result = paginate(
      { page: Number.MAX_SAFE_INTEGER, pageSize: 100 },
      () => 55,
      pageRows
    )

    expect(pageRows).toHaveBeenCalledTimes(1)
    const [limit, offset]: [number, number] = pageRows.mock.calls[0]
    expect(limit).toBe(100)
    expect(offset).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
    expect(offset).toBeLessThan(2 ** 63)
    expect(result.page).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("answers an empty page when the OFFSET leaves SQLite's int64 range", () => {
    const pageRows = vi.fn(() => ["unexpected"])
    const result = paginate(
      { page: 1e18, pageSize: 20 },
      () => 55,
      pageRows
    )

    expect(pageRows).not.toHaveBeenCalled()
    expect(result).toEqual({
      items: [],
      total: 55,
      page: 1e18,
      pageCount: 3,
    })
  })

  it("answers an empty page for a non-finite OFFSET", () => {
    const pageRows = vi.fn(() => ["unexpected"])
    const result = paginate(
      { page: Number.MAX_VALUE, pageSize: 100 },
      () => 0,
      pageRows
    )

    expect(pageRows).not.toHaveBeenCalled()
    expect(result).toEqual({
      items: [],
      total: 0,
      page: Number.MAX_VALUE,
      pageCount: 1,
    })
  })
})
