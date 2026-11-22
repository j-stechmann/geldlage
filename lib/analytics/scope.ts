/**
 * Shared WHERE scaffold for the analytics transaction scopes (ADR-0022/0037).
 *
 * Sharing the scaffold is not merging the scopes: each caller supplies the
 * status allowlist and the date bounds its scope may see, and no builder here
 * accepts `TransactionFilters`. The flow scope keeps `buildWhere` in
 * `queries.ts`; the calendar must never inherit content filters.
 */
import { and, eq, gt, gte, inArray, lt, lte } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { transactions } from "@/lib/db/schema"

export interface TransactionScopeDateBounds {
  /** inclusive lower bound */
  from?: string
  /** inclusive upper bound */
  to?: string
  /** exclusive lower bound (`>`) */
  after?: string
  /** exclusive upper bound (`<`) */
  before?: string
}

export interface TransactionScope {
  userId: number
  accountId?: number
  /** exact non-empty status allowlist; each scope owns its own value(s) */
  statuses: readonly [string, ...string[]]
  dateBounds?: TransactionScopeDateBounds
}

/**
 * User + status allowlist + optional account and caller-supplied date bounds.
 * Built from an allowlist, never by stripping fields off the flow filters — a
 * new filter added to `TransactionFilters` cannot leak here.
 */
export function buildTransactionScope(scope: TransactionScope): SQL {
  // Drizzle renders inArray(col, []) as the literal SQL `false`, which would
  // silently return zero rows. An empty allowlist is a caller bug.
  if (scope.statuses.length === 0) {
    throw new Error("buildTransactionScope requires at least one status")
  }
  const conditions: SQL[] = [
    eq(transactions.userId, scope.userId),
    inArray(transactions.status, scope.statuses),
  ]
  if (scope.accountId !== undefined) {
    conditions.push(eq(transactions.accountId, scope.accountId))
  }
  const { from, to, after, before } = scope.dateBounds ?? {}
  if (from !== undefined) {
    conditions.push(gte(transactions.bookingDate, from))
  }
  if (to !== undefined) {
    conditions.push(lte(transactions.bookingDate, to))
  }
  if (after !== undefined) {
    conditions.push(gt(transactions.bookingDate, after))
  }
  if (before !== undefined) {
    conditions.push(lt(transactions.bookingDate, before))
  }
  return and(...conditions)!
}
