/**
 * Generic deterministic greedy 1:1 pairing (ADR-0037).
 *
 * Shared skeleton only: candidates arrive pre-filtered by the domain's
 * viability predicate, the caller supplies the sort order, and each side is
 * consumed at most once. Import reconciliation (`lib/db/match.ts`) and plan
 * occurrence matching (`lib/planning/matching.ts`) keep their own predicates
 * and comparators — only the sort/consume loop lives here.
 */

export interface GreedyKeys {
  leftKey: string
  rightKey: string
}

export function greedyAssign<T extends GreedyKeys>(
  candidates: readonly T[],
  compare: (a: T, b: T) => number
): T[] {
  const sorted = [...candidates].sort(compare)
  const usedLeft = new Set<string>()
  const usedRight = new Set<string>()
  const chosen: T[] = []
  for (const candidate of sorted) {
    if (usedLeft.has(candidate.leftKey) || usedRight.has(candidate.rightKey)) {
      continue
    }
    usedLeft.add(candidate.leftKey)
    usedRight.add(candidate.rightKey)
    chosen.push(candidate)
  }
  return chosen
}
