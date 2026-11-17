import { describe, it, expect } from "vitest"
import { greedyAssign } from "@/lib/greedy"

interface Pair {
  leftKey: string
  rightKey: string
  distance: number
}

const byDistance = (a: Pair, b: Pair) =>
  a.distance - b.distance ||
  a.leftKey.localeCompare(b.leftKey) ||
  a.rightKey.localeCompare(b.rightKey)

describe("greedyAssign", () => {
  it("consumes each side at most once, closest first", () => {
    const chosen = greedyAssign(
      [
        { leftKey: "a", rightKey: "x", distance: 2 },
        { leftKey: "a", rightKey: "y", distance: 1 },
        { leftKey: "b", rightKey: "x", distance: 3 },
      ],
      byDistance
    )
    expect(chosen).toEqual([
      { leftKey: "a", rightKey: "y", distance: 1 },
      { leftKey: "b", rightKey: "x", distance: 3 },
    ])
  })

  it("is deterministic on ties", () => {
    const candidates: Pair[] = [
      { leftKey: "b", rightKey: "x", distance: 1 },
      { leftKey: "a", rightKey: "y", distance: 1 },
    ]
    expect(greedyAssign(candidates, byDistance)).toEqual([
      { leftKey: "a", rightKey: "y", distance: 1 },
      { leftKey: "b", rightKey: "x", distance: 1 },
    ])
  })

  it("returns empty for no candidates", () => {
    expect(greedyAssign([], byDistance)).toEqual([])
  })

  it("does not mutate the input order", () => {
    const candidates: Pair[] = [
      { leftKey: "a", rightKey: "x", distance: 2 },
      { leftKey: "b", rightKey: "y", distance: 1 },
    ]
    const copy = [...candidates]
    greedyAssign(candidates, byDistance)
    expect(candidates).toEqual(copy)
  })
})
