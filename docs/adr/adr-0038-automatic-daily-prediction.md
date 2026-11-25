# ADR-0038 — Automatic daily prediction; delete the planned-only forecast

## Status

Accepted.

## Context

The planned-only forecast (`computeForecast`,
`GET /api/plans/forecast`, the dashboard toggle and summary card) projected
only occurrences the user had manually planned. Irregular purchases —
groceries, one-off repairs, seasonal spending — were invisible, so the
projection was accurate only for users who planned nearly everything. Issue
#118 asks for a model trained on the user’s own data, with planning
considered.

Constraints:

- Local-first, single Node process, SQLite via better-sqlite3, no second
  service.
- Reference machine: Ryzen 5 5600X, 32 GB RAM, RTX 3070 Ti 8 GB. The local
  27B LLM already occupies most of the VRAM; prediction must not compete for
  it.
- Models must be per owned account and one all-accounts model; availability
  scoped to the session user’s accounts.
- Training must be automatic and start with about one month of data,
  including partial months.
- No new UI: the dashboard charts always show two months of prediction.
- The user asked to try daily granularity before anchoring to a monthly
  aggregate.

## Decision

1. **Delete the planned-only forecast entirely.** Remove
   `computeForecast`, `ForecastResult`, `MAX_FORECAST_MONTHS`,
   `GET /api/plans/forecast`, `ForecastSummary`, `useForecast`,
   `forecastKey`, the “Geplant einblenden” toggle, and their tests/docs.

2. **Pure daily model.** The target is daily residual expenses/income.
   The forecaster is a recursive one-step model; the display horizon
   (`PREDICTION_HORIZON_MONTHS = 2`) is a single constant and changing it
   needs no retraining. No monthly anchor exists.

3. **Try two daily candidates per direction.** A Tweedie GLM (log link,
   variance power 1.5) and a constant trailing-30-day daily baseline compete
   in a single recursive holdout (capped at 60 days). The baseline wins unless the model
   improves MAE by at least 2 %. Feature tiers grow with observed history
   (28/60/180 days), so one month does not overfit.

4. **Plan-aware residual decomposition.** Historical transactions matched to
   active plans are removed from the residual target; unmatched active plan
   occurrences are added exactly on their dates at forecast time. Real future
   booked rows move the balance projection and are exposed as `bookedFuture`;
   the cashflow merge uses them only for prediction-only months because
   existing actual bars normally contain them; a partially filtered existing
   month remains a documented edge.
   Plan edits change the residual definition and enqueue automatic retraining.

5. **Automatic, invisible training.** An in-process coalescing scheduler
   triggers on import reconciliation, plan mutations, account changes,
   startup and stale forecast reads. One `prediction_models` row per
   `(user, scope_key)` stores the artifact, signature and status. The queue
   yields between scopes; failures are contained and retried later.

6. **Always-on two-month chart.** The dashboard fetches
   `GET /api/predictions/forecast` unconditionally. A missing model returns
   the daily baseline with `source: "baseline"`; charts never wait for
   training and there is no toggle or model UI.

7. **No external runtime in v1.** The Tweedie/baseline bake-off trains in
   roughly 0.1 s per scope on the reference dataset. Python/ONNX/LightGBM
   adds image size, IPC and deployment surface without buying speed at this
   scale. The artifact boundary leaves room for a later runner.

## Alternatives considered

- **Fine-tune the local LLM.** Rejected: numerical time-series weakness,
  non-determinism, VRAM contention, slow evaluation.
- **Python/PyTorch/LightGBM sidecar.** Rejected for v1: a second runtime and
  service for no training-speed benefit on local data; a later option behind
  the artifact boundary.
- **Monthly anchor plus daily shape.** Rejected for v1 at the user’s request:
  try daily on its own first; the bake-off reports whether daily works before
  adding an anchor.
- **Direct daily GBDT / hurdle GBDT.** Prototyped; slower and less accurate
  than the Tweedie fit on the local dataset. Kept as a future candidate.
- **Keep the planned-only forecast as a fallback.** Rejected: the old code
  was the source of the inaccurate estimates; the daily baseline is the new
  fallback.

## Consequences

Positive:

- Irregular spending is represented automatically; no manual plan required.
- Plans remain exact and are never double counted.
- Per-account and all-accounts models are isolated and scoped.
- One month of data starts training; no complete-month waiting.
- No new UI; charts always show the intended two months.
- No GPU/Python/native dependency.

Negative / risks:

- Daily prediction is inherently noisy. The bake-off may select the daily
  baseline for short or very irregular histories; that is intentional and
  visible only through `source`, not a UI error.
- Plan edits retrain the affected scopes. Training is cheap; the scheduler
  coalesces bursts.
- Category shares are computed live from the last 90 days of booked
  expenses, not modelled per category.
- Transfers/refunds are still signed cash flow; there is no transfer
  classification.
- The all-accounts snapshot-anchor caveat from the analytics balance remains.

## References

- [prediction.md](../prediction.md)
- [planning.md](../planning.md)
- [analytics.md](../analytics.md)
- Issue #118
