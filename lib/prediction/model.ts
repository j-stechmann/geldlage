/**
 * Daily prediction model.
 *
 * The model is deliberately a pure daily one-step forecaster: the same model
 * is applied recursively for as many days as the chart horizon needs. There
 * is no monthly aggregate in training, and widening the horizon requires no
 * retraining.
 *
 * Two candidates compete automatically per direction:
 * - a Tweedie GLM (log link) for zero-inflated daily money,
 * - a constant trailing daily-rate baseline.
 * The winner is stored in the artifact; when the model is not measurably
 * better, the baseline wins. The bake-off is internal and re-run on every
 * automatic training pass.
 */
import {
  errorMetrics,
  fitTweedie,
  mean,
  tweediePredict,
} from "@/lib/prediction/math"
import {
  LAMBDA_ALPHAS,
  MIN_FEATURE_HISTORY_DAYS,
  MIN_TRAINING_SAMPLES,
  PREDICTION_FEATURE_VERSION,
  TIER1_DAYS,
  TIER2_DAYS,
  TWEEDIE_POWER,
  MAX_VALIDATION_DAYS,
} from "@/lib/prediction/limits"
import type {
  DailySeriesPoint,
  PredictionArtifact,
  PredictionDirection,
  PredictionFeatureSet,
} from "@/lib/prediction/types"

interface TrainingSample {
  x: number[]
  y: number
  weight: number
}

function parseDate(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`)
}

function dayOfWeek(date: string): number {
  return parseDate(date).getUTCDay()
}

function dayOfMonth(date: string): number {
  return Number.parseInt(date.slice(8, 10), 10)
}

function monthOfYear(date: string): number {
  return Number.parseInt(date.slice(5, 7), 10)
}

function isMonthStart(date: string): number {
  return dayOfMonth(date) === 1 ? 1 : 0
}

function isMonthEnd(date: string): number {
  const dt = parseDate(date)
  const next = new Date(dt.getTime() + 86_400_000)
  return next.getUTCMonth() !== dt.getUTCMonth() ? 1 : 0
}

function isPayday(date: string): number {
  const day = dayOfMonth(date)
  return day === 1 || day === 15 ? 1 : 0
}

function trailing(values: readonly number[], n: number): number[] {
  return values.slice(Math.max(0, values.length - n))
}

function trailingMean(values: readonly number[], n: number): number {
  const window = trailing(values, n)
  return window.length ? mean(window) : 0
}

function occurrenceRate(values: readonly number[], n: number): number {
  const window = trailing(values, n)
  if (!window.length) return 0
  return (
    window.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0) / window.length
  )
}

function daysSinceLastPositive(values: readonly number[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] > 0) return values.length - 1 - i
  }
  return Math.min(values.length, 30)
}

export function featureTier(days: number): 0 | 1 | 2 {
  if (days >= TIER2_DAYS) return 2
  if (days >= TIER1_DAYS) return 1
  return 0
}

export function featureNames(tier: 0 | 1 | 2): string[] {
  const names = [
    "intercept",
    "trailing7",
    "trailing30",
    "occ7",
    "occ30",
    "weekend",
    "dowSun",
    "dowMon",
    "dowTue",
    "dowWed",
    "dowThu",
    "dowFri",
    "dowSat",
    "historyDays",
  ]
  if (tier >= 1) {
    names.push(
      "trailing14",
      "occ14",
      "daysSinceLast",
      "domSin1",
      "domCos1",
      "monthSin",
      "monthCos",
      "monthStart",
      "monthEnd",
      "payday"
    )
  }
  if (tier >= 2) {
    names.push("domSin2", "domCos2")
  }
  return names
}

function directionValues(
  history: readonly DailySeriesPoint[],
  direction: PredictionDirection
): number[] {
  return history.map((point) =>
    direction === "expense" ? point.expenseCents : point.incomeCents
  )
}

/**
 * One feature row for `targetDate`, using only history strictly before it.
 * Values are in euros to keep the Tweedie link numerically comfortable; the
 * prediction is converted back to cents by the caller.
 */
export function featureRow(
  history: readonly DailySeriesPoint[],
  targetDate: string,
  direction: PredictionDirection,
  tier: 0 | 1 | 2
): number[] {
  const values = directionValues(history, direction).map((value) => value / 100)
  const dow = dayOfWeek(targetDate)
  const dom = dayOfMonth(targetDate)
  const month = monthOfYear(targetDate)
  const row = [
    1,
    trailingMean(values, 7),
    trailingMean(values, 30),
    occurrenceRate(values, 7),
    occurrenceRate(values, 30),
    dow === 0 || dow === 6 ? 1 : 0,
    dow === 0 ? 1 : 0,
    dow === 1 ? 1 : 0,
    dow === 2 ? 1 : 0,
    dow === 3 ? 1 : 0,
    dow === 4 ? 1 : 0,
    dow === 5 ? 1 : 0,
    dow === 6 ? 1 : 0,
    Math.log1p(values.length) / 8,
  ]
  if (tier >= 1) {
    row.push(
      trailingMean(values, 14),
      occurrenceRate(values, 14),
      Math.min(daysSinceLastPositive(values), 60) / 60,
      Math.sin((2 * Math.PI * dom) / 31),
      Math.cos((2 * Math.PI * dom) / 31),
      Math.sin((2 * Math.PI * month) / 12),
      Math.cos((2 * Math.PI * month) / 12),
      isMonthStart(targetDate),
      isMonthEnd(targetDate),
      isPayday(targetDate)
    )
  }
  if (tier >= 2) {
    row.push(
      Math.sin((4 * Math.PI * dom) / 31),
      Math.cos((4 * Math.PI * dom) / 31)
    )
  }
  return row
}

function trainingSamples(
  series: readonly DailySeriesPoint[],
  direction: PredictionDirection,
  tier: 0 | 1 | 2
): TrainingSample[] {
  const samples: TrainingSample[] = []
  for (let i = MIN_FEATURE_HISTORY_DAYS + 1; i < series.length; i++) {
    const history = series.slice(0, i)
    const point = series[i]
    samples.push({
      x: featureRow(history, point.date, direction, tier),
      y:
        (direction === "expense" ? point.expenseCents : point.incomeCents) /
        100,
      // Recent observations carry more weight; the factor is gentle enough
      // that a year of history still matters.
      weight: Math.pow(0.995, series.length - 1 - i),
    })
  }
  return samples
}

function seriesValues(
  series: readonly DailySeriesPoint[],
  direction: PredictionDirection
): number[] {
  return series.map((point) =>
    direction === "expense" ? point.expenseCents : point.incomeCents
  )
}

function recursiveModelForecast(
  series: readonly DailySeriesPoint[],
  startIndex: number,
  direction: PredictionDirection,
  tier: 0 | 1 | 2,
  model: ReturnType<typeof fitTweedie>
): number[] {
  const history = series.slice(0, startIndex)
  const predictions: number[] = []
  for (let i = startIndex; i < series.length; i++) {
    const targetDate = series[i].date
    const x = featureRow(history, targetDate, direction, tier)
    const predictedCents = tweediePredict(model, x) * 100
    predictions.push(predictedCents)
    history.push({
      date: targetDate,
      expenseCents: direction === "expense" ? predictedCents : 0,
      incomeCents: direction === "income" ? predictedCents : 0,
    })
  }
  return predictions
}

function chooseFeatureSet(
  series: readonly DailySeriesPoint[],
  direction: PredictionDirection,
  tier: 0 | 1 | 2
): PredictionFeatureSet {
  const values = seriesValues(series, direction)
  const baselineRateCents = Math.max(0, mean(trailing(values, 30)))
  const names = featureNames(tier)
  const samples = trainingSamples(series, direction, tier)
  const emptyModel = {
    beta: new Array<number>(names.length).fill(0),
    mean: new Array<number>(names.length).fill(0),
    std: new Array<number>(names.length).fill(1),
  }
  const baselineFallback: PredictionFeatureSet = {
    names,
    model: emptyModel,
    baselineRateCents,
    algorithm: "baseline",
    validationMaeCents: Number.POSITIVE_INFINITY,
    baselineMaeCents: Number.POSITIVE_INFINITY,
  }
  if (samples.length < MIN_TRAINING_SAMPLES) {
    const validation = series.slice(-MIN_TRAINING_SAMPLES)
    const baselineMae = errorMetrics(
      seriesValues(validation, direction),
      validation.map(() => baselineRateCents)
    ).mae
    return {
      ...baselineFallback,
      validationMaeCents: baselineMae,
      baselineMaeCents: baselineMae,
    }
  }

  const validationDays = Math.max(
    7,
    Math.min(MAX_VALIDATION_DAYS, Math.floor(series.length / 4))
  )
  const validationStart = Math.max(
    MIN_FEATURE_HISTORY_DAYS + 1,
    series.length - validationDays
  )
  const trainingPart = series.slice(0, validationStart)
  const training = trainingSamples(trainingPart, direction, tier)
  const validationActual = seriesValues(
    series.slice(validationStart),
    direction
  )
  // The baseline competitor must not look into the validation window: use
  // the trailing rate known at validationStart, exactly like the model.
  const validationBaselineRate = Math.max(
    0,
    mean(trailing(seriesValues(trainingPart, direction), 30))
  )
  const baselineValidationMae = errorMetrics(
    validationActual,
    validationActual.map(() => validationBaselineRate)
  ).mae

  if (training.length < MIN_TRAINING_SAMPLES) {
    return {
      ...baselineFallback,
      validationMaeCents: baselineValidationMae,
      baselineMaeCents: baselineValidationMae,
    }
  }

  let best: {
    model: ReturnType<typeof fitTweedie>
    mae: number
    lambda: number
  } | null = null
  for (const alpha of LAMBDA_ALPHAS) {
    const lambda = Math.max(1, alpha * training.length)
    const model = fitTweedie(
      training.map((sample) => sample.x),
      training.map((sample) => sample.y),
      training.map((sample) => sample.weight),
      lambda,
      TWEEDIE_POWER
    )
    const validation = recursiveModelForecast(
      series,
      validationStart,
      direction,
      tier,
      model
    )
    const mae = errorMetrics(
      seriesValues(series.slice(validationStart), direction),
      validation
    ).mae
    if (!best || mae < best.mae) best = { model, mae, lambda }
  }

  const finalModel = best
    ? fitTweedie(
        samples.map((sample) => sample.x),
        samples.map((sample) => sample.y),
        samples.map((sample) => sample.weight),
        best.lambda,
        TWEEDIE_POWER
      )
    : emptyModel

  // A model must beat the baseline by a real margin to be selected. This
  // keeps daily noise and short histories on the conservative path.
  const useModel = best !== null && best.mae < baselineValidationMae * 0.98
  return {
    names,
    model: useModel ? finalModel : emptyModel,
    baselineRateCents,
    algorithm: useModel ? "tweedie-daily-v1" : "baseline",
    validationMaeCents: useModel ? best!.mae : baselineValidationMae,
    baselineMaeCents: baselineValidationMae,
  }
}

/** Fit both directions of the daily model from a loaded dataset. */
export function trainDailyModel(
  series: readonly DailySeriesPoint[],
  data: {
    from: string
    to: string
    days: number
    transactionCount: number
    planSignature: string
    dataSignature: string
  },
  now: Date = new Date()
): PredictionArtifact {
  const tier = featureTier(data.days)
  const expense = chooseFeatureSet(series, "expense", tier)
  const income = chooseFeatureSet(series, "income", tier)
  return {
    version: 1,
    featureVersion: PREDICTION_FEATURE_VERSION,
    // The algorithm string documents the intended family; each direction's
    // chosen `algorithm` says whether the bake-off selected it or the baseline.
    trainedAt: now.toISOString(),
    data,
    expense,
    income,
    metrics: {
      expenseMaeCents: Math.round(expense.validationMaeCents),
      incomeMaeCents: Math.round(income.validationMaeCents),
      expenseBaselineMaeCents: Math.round(expense.baselineMaeCents),
      incomeBaselineMaeCents: Math.round(income.baselineMaeCents),
    },
  }
}

/** Predict one direction for a target date using the artifact's winner. */
export function predictDirection(
  artifact: PredictionArtifact,
  direction: PredictionDirection,
  history: readonly DailySeriesPoint[],
  targetDate: string
): number {
  const feature = direction === "expense" ? artifact.expense : artifact.income
  if (feature.algorithm === "baseline") {
    // Constant by design: a long import gap must not silently decay the
    // fallback to zero. The rate is refreshed by the next training pass.
    return Math.max(0, Math.round(feature.baselineRateCents))
  }
  const x = featureRow(
    history,
    targetDate,
    direction,
    featureTier(artifact.data.days)
  )
  return Math.max(0, Math.round(tweediePredict(feature.model, x) * 100))
}

/** Exposed for tests: the artifact's training tier. */
export function artifactTier(artifact: PredictionArtifact): 0 | 1 | 2 {
  return featureTier(artifact.data.days)
}
