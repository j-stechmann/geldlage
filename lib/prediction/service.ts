/**
 * Persistence service for automatic prediction models.
 *
 * There is exactly one current model per (user, scope). Training is
 * automatic; this module contains no user-facing lifecycle, only the
 * read/write/validation primitives used by the scheduler and forecast.
 */
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { accounts, predictionModels } from "@/lib/db/schema"
import {
  MAX_ARTIFACT_BYTES,
  PREDICTION_ALGORITHM,
  PREDICTION_FEATURE_VERSION,
} from "@/lib/prediction/limits"
import type {
  PredictionArtifact,
  PredictionScope,
} from "@/lib/prediction/types"

export function scopeKey(accountId: number | null): string {
  return accountId === null ? "all" : `account:${accountId}`
}

/** Account ids owned by the user, deterministic order. */
export function ownedAccountIds(userId: number): number[] {
  return getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all()
    .map((row) => row.id)
    .sort((a, b) => a - b)
}

/** True when the account exists and belongs to the user. */
export function ownsAccount(userId: number, accountId: number): boolean {
  return (
    getDb()
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
      .get() !== undefined
  )
}

export function artifactChecksum(artifactJson: string): string {
  return createHash("sha256").update(artifactJson).digest("hex")
}

function isValidFeatureSet(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const feature = value as {
    names?: unknown
    algorithm?: unknown
    baselineRateCents?: unknown
    model?: { beta?: unknown; mean?: unknown; std?: unknown }
  }
  return (
    Array.isArray(feature.names) &&
    (feature.algorithm === "baseline" ||
      feature.algorithm === "tweedie-daily-v1" ||
      // artifacts written by the pre-versioned branch
      feature.algorithm === "tweedie-daily") &&
    typeof feature.baselineRateCents === "number" &&
    Number.isFinite(feature.baselineRateCents) &&
    feature.baselineRateCents >= 0 &&
    feature.model !== null &&
    typeof feature.model === "object" &&
    Array.isArray(feature.model.beta) &&
    Array.isArray(feature.model.mean) &&
    Array.isArray(feature.model.std) &&
    feature.model.beta.length === feature.names.length &&
    feature.model.mean.length === feature.names.length &&
    feature.model.std.length === feature.names.length
  )
}

function isValidArtifact(value: unknown): value is PredictionArtifact {
  if (!value || typeof value !== "object") return false
  const artifact = value as Partial<PredictionArtifact>
  return (
    artifact.version === 1 &&
    artifact.featureVersion === PREDICTION_FEATURE_VERSION &&
    artifact.data !== null &&
    typeof artifact.data === "object" &&
    typeof artifact.data.from === "string" &&
    typeof artifact.data.to === "string" &&
    typeof artifact.data.days === "number" &&
    Number.isFinite(artifact.data.days) &&
    typeof artifact.data.transactionCount === "number" &&
    Number.isFinite(artifact.data.transactionCount) &&
    typeof artifact.data.dataSignature === "string" &&
    typeof artifact.data.planSignature === "string" &&
    isValidFeatureSet(artifact.expense) &&
    isValidFeatureSet(artifact.income)
  )
}

export interface LoadedPredictionModel {
  id: string
  scope: PredictionScope
  accountId: number | null
  status: "ready" | "training" | "failed"
  trainedAt: string
  dataFrom: string
  dataTo: string
  dataSignature: string
  planSignature: string
  artifact: PredictionArtifact
}

/**
 * Load the current model for a scope. Corrupt or incompatible artifacts are
 * treated as absent so the forecast can fall back to its daily baseline.
 */
export function loadPredictionModel(
  userId: number,
  accountId: number | null
): LoadedPredictionModel | null {
  const row = getDb()
    .select()
    .from(predictionModels)
    .where(
      and(
        eq(predictionModels.userId, userId),
        eq(predictionModels.scopeKey, scopeKey(accountId))
      )
    )
    .get()
  if (!row) return null
  if (
    !row.artifactJson ||
    !row.checksum ||
    !row.trainedAt ||
    !row.dataFrom ||
    !row.dataTo ||
    !row.dataSignature ||
    !row.planSignature
  ) {
    return null
  }
  if (Buffer.byteLength(row.artifactJson, "utf8") > MAX_ARTIFACT_BYTES)
    return null
  if (artifactChecksum(row.artifactJson) !== row.checksum) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.artifactJson)
  } catch {
    return null
  }
  if (!isValidArtifact(parsed)) return null
  return {
    id: row.id,
    scope: { userId, accountId },
    accountId,
    status: row.status as LoadedPredictionModel["status"],
    trainedAt: row.trainedAt,
    dataFrom: row.dataFrom,
    dataTo: row.dataTo,
    dataSignature: row.dataSignature,
    planSignature: row.planSignature,
    artifact: parsed,
  }
}

/**
 * Mark a scope as training, creating a placeholder row before the first fit
 * so a failure can be recorded. The failure path increments `attempts` so
 * retry backoff is durable even when the very first fit throws.
 */
export function markTraining(userId: number, accountId: number | null): void {
  const now = new Date().toISOString()
  getDb()
    .insert(predictionModels)
    .values({
      id: crypto.randomUUID(),
      userId,
      accountId,
      scopeKey: scopeKey(accountId),
      status: "training",
      algorithm: PREDICTION_ALGORITHM,
      featureVersion: PREDICTION_FEATURE_VERSION,
      attempts: 0,
      updatedAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [predictionModels.userId, predictionModels.scopeKey],
      set: {
        status: "training",
        lastError: null,
        nextRetryAt: null,
        updatedAt: now,
      },
    })
    .run()
}

export function markFailed(
  userId: number,
  accountId: number | null,
  error: string
): string {
  const now = new Date().toISOString()
  const row = getDb()
    .select({ attempts: predictionModels.attempts })
    .from(predictionModels)
    .where(
      and(
        eq(predictionModels.userId, userId),
        eq(predictionModels.scopeKey, scopeKey(accountId))
      )
    )
    .get()
  const attempts = Math.max(1, (row?.attempts ?? 0) + 1)
  // Exponential backoff capped at one hour; the dashboard keeps using the
  // last artifact or baseline while this is pending.
  const delayMs = Math.min(
    60_000 * Math.pow(2, Math.min(attempts - 1, 6)),
    60 * 60_000
  )
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString()
  getDb()
    .insert(predictionModels)
    .values({
      id: crypto.randomUUID(),
      userId,
      accountId,
      scopeKey: scopeKey(accountId),
      status: "failed",
      algorithm: PREDICTION_ALGORITHM,
      featureVersion: PREDICTION_FEATURE_VERSION,
      lastError: error.slice(0, 1000),
      attempts,
      nextRetryAt,
      updatedAt: now,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [predictionModels.userId, predictionModels.scopeKey],
      set: {
        status: "failed",
        lastError: error.slice(0, 1000),
        attempts,
        nextRetryAt,
        updatedAt: now,
      },
    })
    .run()
  return nextRetryAt
}

/** The scheduled retry instant, or null when the scope is not backing off. */
export function predictionNextRetryAt(
  userId: number,
  accountId: number | null
): string | null {
  const row = getDb()
    .select({
      status: predictionModels.status,
      nextRetryAt: predictionModels.nextRetryAt,
    })
    .from(predictionModels)
    .where(
      and(
        eq(predictionModels.userId, userId),
        eq(predictionModels.scopeKey, scopeKey(accountId))
      )
    )
    .get()
  if (!row || row.status !== "failed" || !row.nextRetryAt) return null
  return row.nextRetryAt
}

/** True when a failed scope is due for another automatic attempt. */
export function predictionRetryDue(
  userId: number,
  accountId: number | null
): boolean {
  const retryAt = predictionNextRetryAt(userId, accountId)
  return retryAt === null || retryAt <= new Date().toISOString()
}

export interface SavePredictionModelInput {
  userId: number
  accountId: number | null
  artifact: PredictionArtifact
}

export function savePredictionModel(input: SavePredictionModelInput): void {
  const artifactJson = JSON.stringify(input.artifact)
  if (Buffer.byteLength(artifactJson, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new Error("prediction model artifact exceeds the size cap")
  }
  const db = getDb()
  const now = new Date().toISOString()
  const row = {
    userId: input.userId,
    accountId: input.accountId,
    scopeKey: scopeKey(input.accountId),
    status: "ready" as const,
    algorithm: PREDICTION_ALGORITHM,
    featureVersion: PREDICTION_FEATURE_VERSION,
    dataFrom: input.artifact.data.from,
    dataTo: input.artifact.data.to,
    dayCount: input.artifact.data.days,
    transactionCount: input.artifact.data.transactionCount,
    dataSignature: input.artifact.data.dataSignature,
    planSignature: input.artifact.data.planSignature,
    artifactJson,
    metricsJson: JSON.stringify(input.artifact.metrics),
    checksum: artifactChecksum(artifactJson),
    lastError: null,
    attempts: 0,
    nextRetryAt: null,
    trainedAt: input.artifact.trainedAt,
    updatedAt: now,
    createdAt: now,
  }
  db.insert(predictionModels)
    .values(row)
    .onConflictDoUpdate({
      target: [predictionModels.userId, predictionModels.scopeKey],
      set: {
        accountId: row.accountId,
        status: row.status,
        algorithm: row.algorithm,
        featureVersion: row.featureVersion,
        dataFrom: row.dataFrom,
        dataTo: row.dataTo,
        dayCount: row.dayCount,
        transactionCount: row.transactionCount,
        dataSignature: row.dataSignature,
        planSignature: row.planSignature,
        artifactJson: row.artifactJson,
        metricsJson: row.metricsJson,
        checksum: row.checksum,
        lastError: row.lastError,
        attempts: row.attempts,
        nextRetryAt: row.nextRetryAt,
        trainedAt: row.trainedAt,
        updatedAt: row.updatedAt,
      },
    })
    .run()
}

/** On startup, any in-flight training row is stale; the sweep retrains it. */
export function resetInterruptedPredictionModels(): number {
  const result = getDb()
    .update(predictionModels)
    .set({
      status: "failed",
      lastError: "interrupted by server restart",
      nextRetryAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(predictionModels.status, "training"))
    .run()
  return result.changes
}

/** Delete the all-model or one account model (account cascades also cover this). */
export function deletePredictionModel(
  userId: number,
  accountId: number | null
): number {
  const result = getDb()
    .delete(predictionModels)
    .where(
      and(
        eq(predictionModels.userId, userId),
        eq(predictionModels.scopeKey, scopeKey(accountId))
      )
    )
    .run()
  return result.changes
}
