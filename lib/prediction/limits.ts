/**
 * Prediction limits and defaults. Shared by the server model, scheduler and
 * forecast route. The display horizon is a single constant so widening the
 * chart's forecast window is a one-line change.
 */
import { PREDICTION_HORIZON_MONTHS } from "@/lib/contracts/prediction"

/** Chart/forecast horizon in calendar months (current remainder + next). */
export { PREDICTION_HORIZON_MONTHS }

/** History window used to train a model (daily rows, ~3 years). */
export const MAX_TRAINING_DAYS = 1095

/** Minimum span of booked history before a model may be trained. */
export const MIN_TRAINING_DAYS = 28

/** Minimum one-step training samples (day t-1 -> t) for a model. */
export const MIN_TRAINING_SAMPLES = 13

/** Validation window used by the automatic daily-vs-baseline bake-off.
 * Matches the chart horizon so the bake-off judges the forecast users see. */
export const MAX_VALIDATION_DAYS = 60

/** Feature warm-up: enough days to compute the short trailing windows. */
export const MIN_FEATURE_HISTORY_DAYS = 7

/** Tier boundaries for the daily feature set. */
export const TIER1_DAYS = 60
export const TIER2_DAYS = 180

/** Tweedie variance power used by the daily GLM. */
export const TWEEDIE_POWER = 1.5

/** Ridge strengths tried per direction during the bake-off. */
export const LAMBDA_ALPHAS = [0.3, 1, 3, 10] as const

/** Hard cap for the JSON artifact stored in SQLite. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024

/** Model artifact/algorithm version. Bump when the feature set changes. */
export const PREDICTION_FEATURE_VERSION = 1
export const PREDICTION_ALGORITHM = "tweedie-daily-v1"
