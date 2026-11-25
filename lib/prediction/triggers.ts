/**
 * App-layer seam for prediction invalidation.
 *
 * Plan/import/account write paths call these helpers instead of importing the
 * scheduler directly at every call site; a future write path then has one
 * obvious place to hook into. The helpers stay outside `lib/planning` so the
 * planning domain remains prediction-free.
 */
import {
  scheduleAfterAccountDelete,
  scheduleAfterImport,
  scheduleAfterPlanChange,
  schedulePredictionTraining,
} from "@/lib/prediction/scheduler"

function bestEffort(label: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    console.error(`[prediction] ${label} trigger failed:`, error)
  }
}

export function notifyPlanChanged(
  userId: number,
  accountId: number | null
): void {
  bestEffort("plan", () => scheduleAfterPlanChange(userId, accountId))
}

export function notifyImportCommitted(userId: number, accountId: number): void {
  bestEffort("import", () => scheduleAfterImport(userId, accountId))
}

export function notifyAccountCreated(userId: number, accountId: number): void {
  bestEffort("account create", () => {
    schedulePredictionTraining(userId, accountId, true)
    schedulePredictionTraining(userId, null, true)
  })
}

export function notifyAccountDeleted(userId: number, accountId: number): void {
  bestEffort("account delete", () =>
    scheduleAfterAccountDelete(userId, accountId)
  )
}
