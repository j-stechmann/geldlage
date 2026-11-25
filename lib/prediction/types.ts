/**
 * Server-side prediction artifact and dataset types.
 *
 * This module is never imported by client components. It describes the JSON
 * persisted in `prediction_models.artifact_json`.
 */
import type { StandardizedModel } from "@/lib/prediction/math"

export type PredictionDirection = "expense" | "income"
export type PredictionAlgorithm =
  "tweedie-daily-v1" | "tweedie-daily" | "baseline"

export interface DailySeriesPoint {
  date: string
  /** positive expense magnitude in cents */
  expenseCents: number
  /** positive income magnitude in cents */
  incomeCents: number
}

export interface PredictionFeatureSet {
  names: string[]
  model: StandardizedModel
  /** baseline constant daily rate used when the model loses the bake-off */
  baselineRateCents: number
  algorithm: PredictionAlgorithm
  validationMaeCents: number
  baselineMaeCents: number
}

export interface PredictionArtifact {
  version: 1
  featureVersion: number
  trainedAt: string
  data: {
    from: string
    to: string
    days: number
    transactionCount: number
    planSignature: string
    dataSignature: string
  }
  expense: PredictionFeatureSet
  income: PredictionFeatureSet
  metrics: {
    expenseMaeCents: number
    incomeMaeCents: number
    expenseBaselineMaeCents: number
    incomeBaselineMaeCents: number
  }
}

export interface PredictionScope {
  userId: number
  accountId: number | null
}
