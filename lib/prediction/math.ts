/**
 * Small numeric toolkit for the daily prediction model.
 *
 * Pure, dependency-free, deterministic. The matrices are tiny (at most ~30
 * features), so a Cholesky solve on the normal equations is sufficient and
 * keeps the reference-machine footprint negligible.
 */

export interface StandardizedModel {
  /** coefficients in standardized feature space; [0] is the intercept */
  beta: number[]
  /** per-feature training mean; [0] is unused (intercept) */
  mean: number[]
  /** per-feature training standard deviation; [0] is 1 */
  std: number[]
}

export function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

export function std(values: readonly number[]): number {
  if (values.length < 2) return 0
  const mu = mean(values)
  const variance =
    values.reduce((sum, value) => sum + (value - mu) ** 2, 0) /
    (values.length - 1)
  return Math.sqrt(variance)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function dot(beta: readonly number[], x: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < beta.length; i++) sum += beta[i] * x[i]
  return sum
}

function weightedMean(
  values: readonly number[],
  weights: readonly number[]
): number {
  let sum = 0
  let weight = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * weights[i]
    weight += weights[i]
  }
  return weight > 0 ? sum / weight : 0
}

function weightedStd(
  values: readonly number[],
  weights: readonly number[],
  mu: number
): number {
  let sum = 0
  let weight = 0
  for (let i = 0; i < values.length; i++) {
    sum += weights[i] * (values[i] - mu) ** 2
    weight += weights[i]
  }
  return weight > 0 ? Math.sqrt(sum / weight) : 0
}

/**
 * Solve `A x = b` for a symmetric positive-definite A via Cholesky.
 * A tiny diagonal jitter keeps nearly singular standardized designs solvable.
 */
function choleskySolve(A: number[][], b: number[]): number[] {
  const n = A.length
  const L: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0)
  )
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j]
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k]
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(sum, 1e-12))
      } else {
        L[i][j] = sum / L[j][j]
      }
    }
  }
  const y = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let sum = b[i]
    for (let k = 0; k < i; k++) sum -= L[i][k] * y[k]
    y[i] = sum / L[i][i]
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]
    for (let k = i + 1; k < n; k++) sum -= L[k][i] * x[k]
    x[i] = sum / L[i][i]
  }
  return x
}

/** Weighted ridge solve on an already-prepared design matrix. */
function solveRidgeRaw(
  Z: readonly number[][],
  y: readonly number[],
  weights: readonly number[],
  lambda: number
): number[] {
  const p = Z[0]?.length ?? 1
  const A: number[][] = Array.from({ length: p }, () =>
    new Array<number>(p).fill(0)
  )
  const b = new Array<number>(p).fill(0)
  for (let i = 0; i < Z.length; i++) {
    const weight = weights[i]
    for (let j = 0; j < p; j++) {
      b[j] += weight * Z[i][j] * y[i]
      for (let k = 0; k <= j; k++) A[j][k] += weight * Z[i][j] * Z[i][k]
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[k][j] = A[j][k]
  }
  // The intercept is never penalized; all standardized slopes are.
  for (let j = 1; j < p; j++) A[j][j] += lambda
  return choleskySolve(A, b)
}

/**
 * Weighted ridge with an unpenalized intercept:
 *   Σ w_i (y_i - x_iᵀβ)² + λ Σ_{j≥1} β_j²
 * Returns coefficients in the original (unstandardized) feature space via
 * the stored standardization statistics.
 */
export function fitWeightedRidge(
  X: readonly number[][],
  y: readonly number[],
  weights: readonly number[],
  lambda: number
): StandardizedModel {
  const p = X[0]?.length ?? 1
  const means = new Array<number>(p).fill(0)
  const stds = new Array<number>(p).fill(1)
  for (let j = 1; j < p; j++) {
    const column = X.map((row) => row[j])
    means[j] = weightedMean(column, weights)
    stds[j] = weightedStd(column, weights, means[j]) || 1
  }
  const Z = X.map((row) =>
    row.map((value, j) => (j === 0 ? 1 : (value - means[j]) / stds[j]))
  )
  const beta = solveRidgeRaw(Z, y, weights, lambda)
  return { beta, mean: means, std: stds }
}

export function predictStandardized(
  model: StandardizedModel,
  x: readonly number[]
): number {
  let value = model.beta[0]
  for (let j = 1; j < model.beta.length; j++) {
    value += model.beta[j] * ((x[j] - model.mean[j]) / model.std[j])
  }
  return value
}

/**
 * Tweedie GLM with log link and variance power p in (1, 2), fitted by IRLS.
 *
 * Daily finance data is zero-inflated but positive when money moves; the
 * Tweedie family covers that shape without a separate occurrence model. The
 * implementation follows the standard IRLS update
 *   η ← η − gradient / hessian,  weights = hessian
 * with sample weights folded into both the working weights and the ridge
 * penalty.
 */
export function fitTweedie(
  X: readonly number[][],
  y: readonly number[],
  sampleWeights: readonly number[],
  lambda: number,
  power = 1.5
): StandardizedModel {
  const p = X[0]?.length ?? 1
  const means = new Array<number>(p).fill(0)
  const stds = new Array<number>(p).fill(1)
  for (let j = 1; j < p; j++) {
    const column = X.map((row) => row[j])
    means[j] = weightedMean(column, sampleWeights)
    stds[j] = weightedStd(column, sampleWeights, means[j]) || 1
  }
  const Z = X.map((row) =>
    row.map((value, j) => (j === 0 ? 1 : (value - means[j]) / stds[j]))
  )
  const beta = new Array<number>(p).fill(0)
  const base = Math.max(1e-6, mean(y))
  beta[0] = Math.log(base)
  if (!Number.isFinite(beta[0])) beta[0] = 0

  for (let iteration = 0; iteration < 40; iteration++) {
    const eta = Z.map((row) => clamp(dot(beta, row), -20, 20))
    const mu = eta.map((value) => Math.exp(value))
    const workingWeights = new Array<number>(Z.length).fill(0)
    const workingResponse = new Array<number>(Z.length).fill(0)
    for (let i = 0; i < Z.length; i++) {
      const m = Math.max(1e-6, mu[i])
      const gradient = -y[i] * Math.pow(m, 1 - power) + Math.pow(m, 2 - power)
      const hessian =
        (2 - power) * Math.pow(m, 2 - power) -
        (1 - power) * y[i] * Math.pow(m, 1 - power)
      const h = Math.max(1e-6, hessian) * Math.max(1e-6, sampleWeights[i])
      workingWeights[i] = h
      workingResponse[i] = eta[i] - gradient / Math.max(1e-6, hessian)
    }
    const next = solveRidgeRaw(Z, workingResponse, workingWeights, lambda)
    let maxChange = 0
    for (let j = 0; j < p; j++) {
      maxChange = Math.max(maxChange, Math.abs(next[j] - beta[j]))
      beta[j] = next[j]
    }
    if (maxChange < 1e-7) break
  }

  return { beta, mean: means, std: stds }
}

export function tweediePredict(
  model: StandardizedModel,
  x: readonly number[]
): number {
  return Math.max(0, Math.exp(clamp(predictStandardized(model, x), -20, 20)))
}

export interface ErrorMetrics {
  mae: number
  wape: number | null
  bias: number
}

export function errorMetrics(
  actual: readonly number[],
  predicted: readonly number[]
): ErrorMetrics {
  if (actual.length === 0) return { mae: 0, wape: null, bias: 0 }
  let absolute = 0
  let signed = 0
  let total = 0
  for (let i = 0; i < actual.length; i++) {
    absolute += Math.abs(actual[i] - predicted[i])
    signed += actual[i] - predicted[i]
    total += Math.abs(actual[i])
  }
  return {
    mae: absolute / actual.length,
    wape: total > 0 ? absolute / total : null,
    bias: signed / actual.length,
  }
}
