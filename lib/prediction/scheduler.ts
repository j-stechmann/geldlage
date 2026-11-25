/**
 * Automatic prediction scheduler.
 *
 * Training is invisible: imports, plan edits, account changes and the
 * forecast read itself enqueue the affected scopes. The queue coalesces
 * duplicates and yields between scopes so the single Node process keeps
 * serving requests and the label worker.
 */
import { getDb } from "@/lib/db"
import { transactions } from "@/lib/db/schema"
import { todayLocal } from "@/lib/dates"
import { loadDailyDataset } from "@/lib/prediction/dataset"
import { trainDailyModel } from "@/lib/prediction/model"
import { MIN_TRAINING_DAYS } from "@/lib/prediction/limits"
import {
  deletePredictionModel,
  loadPredictionModel,
  markFailed,
  markTraining,
  predictionNextRetryAt,
  predictionRetryDue,
  ownedAccountIds,
  resetInterruptedPredictionModels,
  savePredictionModel,
  scopeKey,
} from "@/lib/prediction/service"
import type { DailyDataset } from "@/lib/prediction/dataset"

interface ScopeJob {
  userId: number
  accountId: number | null
  /** explicit data-change triggers bypass the failure backoff */
  force: boolean
}

type SchedulerState = {
  queue: Map<string, ScopeJob>
  retries: Map<string, ReturnType<typeof setTimeout>>
  running: boolean
  started: boolean
}

const globalRef = globalThis as unknown as {
  __geldlagePredictionScheduler?: SchedulerState
}

function state(): SchedulerState {
  if (!globalRef.__geldlagePredictionScheduler) {
    globalRef.__geldlagePredictionScheduler = {
      queue: new Map(),
      retries: new Map(),
      running: false,
      started: false,
    }
  }
  // A hot reload can find a scheduler global created by a previous shape
  // that did not have the retry map yet.
  globalRef.__geldlagePredictionScheduler.retries ??= new Map()
  return globalRef.__geldlagePredictionScheduler
}

function jobKey(userId: number, accountId: number | null): string {
  return `${userId}:${scopeKey(accountId)}`
}

/** Queue one scope; coalesces with an already queued identical scope. */
export function schedulePredictionTraining(
  userId: number,
  accountId: number | null,
  force = false
): void {
  const scheduler = state()
  const key = jobKey(userId, accountId)
  if (force) {
    const timer = scheduler.retries.get(key)
    if (timer) {
      clearTimeout(timer)
      scheduler.retries.delete(key)
    }
  }
  const prior = scheduler.queue.get(key)
  scheduler.queue.set(key, {
    userId,
    accountId,
    force: force || prior?.force === true,
  })
  if (!scheduler.running) {
    // Start the drain on the next tick: an async function runs synchronously
    // until its first await, and a forecast read must never train inline.
    setImmediate(() => {
      void drain().catch((error) => {
        console.error("[prediction] scheduler drain failed:", error)
      })
    })
  }
}

/** Queue all scopes a user can have: all-accounts plus each owned account. */
export function schedulePredictionForUser(userId: number, force = false): void {
  schedulePredictionTraining(userId, null, force)
  for (const accountId of ownedAccountIds(userId)) {
    schedulePredictionTraining(userId, accountId, force)
  }
}

/** Import changes one account and the all-accounts aggregate. */
export function scheduleAfterImport(userId: number, accountId: number): void {
  schedulePredictionTraining(userId, accountId, true)
  schedulePredictionTraining(userId, null, true)
}

/** Plan edits affect the plan's account (or every account) and the aggregate. */
export function scheduleAfterPlanChange(
  userId: number,
  accountId: number | null
): void {
  if (accountId === null) {
    schedulePredictionForUser(userId, true)
  } else {
    schedulePredictionTraining(userId, accountId, true)
    schedulePredictionTraining(userId, null, true)
  }
}

/** Account removal: drop the account model and refresh the aggregate. */
export function scheduleAfterAccountDelete(
  userId: number,
  accountId: number
): void {
  deletePredictionModel(userId, accountId)
  schedulePredictionTraining(userId, null, true)
}

/**
 * The forecast read calls this with the dataset it already loaded. A missing
 * or stale model is enqueued in the background; the current forecast still
 * uses the existing artifact or the daily baseline.
 */
export function scheduleIfStale(
  userId: number,
  accountId: number | null,
  dataset: DailyDataset,
  loaded?: ReturnType<typeof loadPredictionModel>,
  retryDue?: boolean
): void {
  if (dataset.series.length < MIN_TRAINING_DAYS) return
  const current =
    loaded === undefined ? loadPredictionModel(userId, accountId) : loaded
  if (!(retryDue ?? predictionRetryDue(userId, accountId))) return
  if (modelNeedsRefresh(current, dataset)) {
    schedulePredictionTraining(userId, accountId)
  }
}

/** Shared staleness predicate (forecast and scheduler must agree). */
export function modelNeedsRefresh(
  current: ReturnType<typeof loadPredictionModel>,
  dataset: Pick<DailyDataset, "dataSignature" | "planSignature">
): boolean {
  return (
    !current ||
    current.status !== "ready" ||
    current.dataSignature !== dataset.dataSignature ||
    current.planSignature !== dataset.planSignature
  )
}

async function drain(): Promise<void> {
  const scheduler = state()
  if (scheduler.running) return
  scheduler.running = true
  try {
    while (scheduler.queue.size > 0) {
      const [key, job] = scheduler.queue.entries().next().value as [
        string,
        ScopeJob,
      ]
      scheduler.queue.delete(key)
      // Clear first: a non-forced job for a persisted backed-off scope
      // re-arms the timer inside trainScope, and clearing afterwards would
      // immediately cancel that wakeup.
      clearRetry(job.userId, job.accountId)
      try {
        trainScope(job.userId, job.accountId, todayLocal(), job.force)
      } catch (error) {
        try {
          const retryAt = markFailed(
            job.userId,
            job.accountId,
            error instanceof Error
              ? error.message
              : "prediction training failed"
          )
          scheduleRetry(job.userId, job.accountId, retryAt)
        } catch (markError) {
          console.error(
            `[prediction] could not persist failure for ${jobKey(job.userId, job.accountId)}:`,
            markError
          )
        }
        console.error(
          `[prediction] training failed for ${jobKey(job.userId, job.accountId)}:`,
          error
        )
      }
      // Let HTTP handlers and the label worker run between scopes.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  } finally {
    scheduler.running = false
  }
}

/** Synchronous training for one scope (also the test seam). */
export function trainScope(
  userId: number,
  accountId: number | null,
  today: string = todayLocal(),
  force = false
): void {
  const dataset = loadDailyDataset(userId, accountId, today)
  if (!dataset || dataset.series.length < MIN_TRAINING_DAYS) return
  const current = loadPredictionModel(userId, accountId)
  if (current && !modelNeedsRefresh(current, dataset)) return
  if (!force) {
    const retryAt = predictionNextRetryAt(userId, accountId)
    if (retryAt && retryAt > new Date().toISOString()) {
      // Re-arm the wakeup after a process restart or a dropped timer.
      scheduleRetry(userId, accountId, retryAt)
      return
    }
  }
  markTraining(userId, accountId)
  const artifact = trainDailyModel(dataset.series, {
    from: dataset.series[0].date,
    to: dataset.series[dataset.series.length - 1].date,
    days: dataset.series.length,
    transactionCount: dataset.transactionCount,
    planSignature: dataset.planSignature,
    dataSignature: dataset.dataSignature,
  })
  savePredictionModel({ userId, accountId, artifact })
}

/**
 * Startup sweep: recover interrupted rows, then enqueue every user/scope that
 * has data. Deliberately delayed so the app can finish bootstrapping.
 */
export function startPredictionScheduler(): void {
  const scheduler = state()
  if (scheduler.started) return
  scheduler.started = true
  try {
    const interrupted = resetInterruptedPredictionModels()
    if (interrupted > 0) {
      console.log(
        `[prediction] reset ${interrupted} interrupted training row(s)`
      )
    }
  } catch (error) {
    console.error("[prediction] startup recovery failed:", error)
  }
  setTimeout(() => {
    try {
      const userIds = getDb()
        .selectDistinct({ userId: transactions.userId })
        .from(transactions)
        .all()
        .map((row) => row.userId)
      for (const userId of userIds) schedulePredictionForUser(userId)
    } catch (error) {
      console.error("[prediction] startup sweep failed:", error)
    }
  }, 3000).unref()
}

function clearRetry(userId: number, accountId: number | null): void {
  const scheduler = state()
  const key = jobKey(userId, accountId)
  const timer = scheduler.retries.get(key)
  if (timer) {
    clearTimeout(timer)
    scheduler.retries.delete(key)
  }
}

function scheduleRetry(
  userId: number,
  accountId: number | null,
  retryAt: string
): void {
  const scheduler = state()
  const key = jobKey(userId, accountId)
  const prior = scheduler.retries.get(key)
  if (prior) clearTimeout(prior)
  const parsed = Date.parse(retryAt)
  const delay = Number.isFinite(parsed)
    ? Math.max(1000, parsed - Date.now() + 1000)
    : 60_000
  const timer = setTimeout(() => {
    scheduler.retries.delete(key)
    schedulePredictionTraining(userId, accountId, true)
  }, delay)
  timer.unref()
  scheduler.retries.set(key, timer)
}

/** Test seam: queued scopes before the drain starts. */
export function predictionQueueSizeForTest(): number {
  return state().queue.size
}

/** Test seam: whether the startup sweep has been marked started. */
export function predictionSchedulerStartedForTest(): boolean {
  return state().started
}

/** Test seam: arm a retry timer for an arbitrary retryAt. */
export function scheduleRetryForTest(
  userId: number,
  accountId: number | null,
  retryAt: string
): void {
  scheduleRetry(userId, accountId, retryAt)
}

/** Test seam: number of armed retry wakeups. */
export function predictionRetryTimerCountForTest(): number {
  return state().retries.size
}

/** Test seam: clear any queued/running state left by an earlier test. */
export function resetPredictionSchedulerForTest(): void {
  const scheduler = state()
  scheduler.queue.clear()
  for (const timer of scheduler.retries.values()) clearTimeout(timer)
  scheduler.retries.clear()
  scheduler.running = false
  scheduler.started = false
}

/** Test seam: wait until the background queue is empty. */
export async function waitForPredictionIdleForTest(): Promise<void> {
  const scheduler = state()
  while (scheduler.running || scheduler.queue.size > 0) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
