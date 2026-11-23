/**
 * Shared snapshot-anchor and time-scoped balance predicates (ADR-0037).
 *
 * Extracted verbatim from `engine.ts` so the forecast reuses the exact same
 * anchor pick and booked predicate instead of mirroring them. This module is
 * the *implementation* both scopes share; the scopes themselves stay
 * separate (ADR-0022): this predicate never accepts `TransactionFilters`.
 */
import { and, desc, eq, isNotNull, lte } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches } from "@/lib/db/schema"
import {
  buildTransactionScope,
  type TransactionScopeDateBounds,
} from "@/lib/analytics/scope"

export interface BalanceAnchor {
  snapshotDate: string
  snapshotAmountCents: number
  /** deterministic same-day tie-break part: fresher import wins */
  createdAt: string
  /** deterministic last tie-break part (createdAt is not unique) */
  id: string
}

export type TimeScopedDateBounds = TransactionScopeDateBounds

/**
 * Time-scoped balance predicate: user + booked rows + optional account and
 * caller-supplied date bounds. Delegates the shared scaffold but keeps the
 * booked-only status predicate local to this scope.
 */
export function buildTimeScopedWhere(
  userId: number,
  accountId: number | undefined,
  dateBounds?: TimeScopedDateBounds
): SQL {
  return buildTransactionScope({
    userId,
    accountId,
    statuses: ["Gebucht"],
    dateBounds,
  })
}

/** Snapshot rows that can anchor a balance as of `today`. */
function snapshotWhere(
  userId: number,
  accountId: number | undefined,
  today: string
): SQL {
  const conditions: SQL[] = [
    eq(importBatches.userId, userId),
    isNotNull(importBatches.snapshotDate),
    isNotNull(importBatches.snapshotAmountCents),
    // a snapshot dated after today is not a "current balance" point yet —
    // anchoring on it would let the KPI name a snapshot the forecast rejects
    lte(importBatches.snapshotDate, today),
  ]
  if (accountId !== undefined) {
    conditions.push(eq(importBatches.accountId, accountId))
  }
  return and(...conditions)!
}

/**
 * Balance anchor = LATEST snapshot across all batches (most recent known
 * absolute balance point). Current balance = snapshot + Σ(booked amounts
 * with booking_date > snapshot_date) — robust to missing older history.
 * Batches tied on snapshotDate resolve deterministically, freshest import
 * first: SQL orders by snapshot_date, created_at, id — all descending.
 * Snapshots dated AFTER today are ignored — both the balance KPI and
 * computeForecast apply this identical rule, so a future-dated Saldo line
 * never anchors one scope alone.
 */
export function latestAnchor(
  userId: number,
  accountId: number | undefined,
  today: string
): BalanceAnchor | null {
  const db = getDb()
  const row = db
    .select({
      id: importBatches.id,
      createdAt: importBatches.createdAt,
      snapshotDate: importBatches.snapshotDate,
      snapshotAmountCents: importBatches.snapshotAmountCents,
    })
    .from(importBatches)
    .where(snapshotWhere(userId, accountId, today))
    .orderBy(
      desc(importBatches.snapshotDate),
      desc(importBatches.createdAt),
      desc(importBatches.id)
    )
    .limit(1)
    .get()
  // snapshotWhere's isNotNull guards make both snapshot columns non-null at
  // runtime; Drizzle cannot infer that from a WHERE clause, hence the cast.
  // SQLite's BINARY collation matches the old JS `>` comparator for these
  // ASCII ISO date/timestamp/UUID values.
  return (row as BalanceAnchor | undefined) ?? null
}
