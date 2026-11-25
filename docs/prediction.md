# Prediction (automatic daily forecast)

The dashboard always shows **two months** of prediction. There is no toggle,
no training button and no model page. Each owned account gets its own daily
model, plus one all-accounts model per user; imports, plan edits and account
changes enqueue retraining automatically. Implemented per
[ADR-0038](adr/adr-0038-automatic-daily-prediction.md).

The old planned-only forecast (`computeForecast`,
`GET /api/plans/forecast`, `ForecastResult`, the “Geplant einblenden”
toggle and its summary card) was removed entirely. Plans remain inputs to
the new engine ([planning.md](planning.md)).

## Decomposition

For each scope (one account, or all owned accounts):

```text
chart(day)   = predicted daily residual + active unmatched plan occurrences
balance(day) = chart(day) + already-booked future rows
```

- **Residual** = booked daily expenses/income not matched to an active plan.
  The read-time plan matcher ([planning.md](planning.md)) decides this.
- **Plans** are added exactly on their dates. Paused/finished plans are not
  projected.
- **Real future booked rows** are certain money. They move the balance
  projection (which starts today) and are exposed per month as
  `bookedFuture`. The cashflow chart normally leaves them to the actual
  analytics bars; if a prediction-only month has no actual row (e.g. a
  date-filtered view), the merge adds `bookedFuture` to that month's
  predicted bar. The categories chart follows the actual filter and does not
  re-add `bookedFuture` categories. Known limitation: a partial-month date
  range or a status/category filter can leave an existing actual month whose
  bar excludes some booked future rows; the prediction-only fallback then
  does not re-add them.
- The starting balance uses the shared snapshot anchor in
  [lib/analytics/balance.ts](../lib/analytics/balance.ts) (latest snapshot
  ≤ today + booked movement; no snapshot → sum of booked rows).

The residual target is defined with the **current active plans**. A plan edit
therefore changes the target and the scheduler retrains the affected scope.
Active-plan matching is excluded from training; paused/finished plan matches
stay in the residual because those plans are not added to the forecast.

## Daily model

`tweedie-daily-v1` is a **daily** model: the target is a daily amount and the
forecaster is recursive one-step. There is no monthly anchor.

Two candidates compete automatically per direction:

1. **Tweedie GLM** with log link (variance power 1.5) — zero-inflated daily
   money in one model. Standardized features, unpenalized intercept, L2
   penalty `λ = α·n` with `α` selected from `{0.3, 1, 3, 10}`.
2. **Constant trailing daily-rate baseline** (mean of the last 30 days).

A single recursive holdout over the last up to 60 days picks the lower MAE.
The model is selected only when it beats the pre-validation baseline by at
least 2 %; otherwise the baseline wins. This prevents a noisy daily model
from being presented as certainty while still trying daily on its merits.

### Feature tiers

Feature count grows with observed history so one month does not overfit:

| Tier | Threshold  | Features                                                                                                                     |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0    | ≥ 28 days  | trailing 7/30-day mean, trailing 7/30-day occurrence rate, weekday one-hot, weekend, history length                          |
| 1    | ≥ 60 days  | + trailing 14-day mean/occurrence, days since last transaction, day-of-month sin/cos, month sin/cos, month start/end, payday |
| 2    | ≥ 180 days | + second day-of-month harmonic                                                                                               |

All features are computed from history strictly before the target day.
Sample weights decay gently (`0.995^age`) so recent behavior matters without
discarding seasonal history.

### Recursive forecast and partial months

The model predicts `today → tomorrow`, appends the prediction to history and
repeats through the horizon. Changing the display horizon is a one-line
constant (`PREDICTION_HORIZON_MONTHS = 2`); the model needs no retraining.
UI copy derives the number from the same constant; only tests with
exact-count assertions need updating.

Training uses all observed days, including partial months at either edge.
The minimum is **28 observed days** (and 13 one-step samples); no
complete-month requirement exists. Days between the last booking and today
are treated as zero-spend days when building forecast features; they are not
part of the training span.

## Scopes and availability

One row per scope in `prediction_models`:

- `scope_key = "account:<id>"` for each owned account;
- `scope_key = "all"` for the all-accounts aggregate.

`GET /api/predictions/forecast?accountId=` resolves the exact scope. A
foreign/unknown account id is a 400; an account model is never substituted
with another account’s model. The all-accounts model aggregates every owned
account. Account-agnostic plans (`account_id` NULL) apply to every
account-scoped model, matching the calendar/plan-list convention.

A brand-new account with less than 28 observed days has no model; its chart
forecast is the daily baseline from whatever data exists. The forecast route
still returns 200 and the two-month envelope.

## Automatic maintenance

The scheduler is an in-process coalescing queue
([lib/prediction/scheduler.ts](../lib/prediction/scheduler.ts)):

| Trigger                   | Scopes                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| import reconcile finishes | imported account + all-accounts                                        |
| plan create/update/delete | plan account (or every account for NULL) + all-accounts                |
| account create/delete     | all-accounts + the new account; deleted account row cascades away      |
| startup                   | reset interrupted `training` rows, sweep users with bookings after 3 s |
| forecast read             | signature check enqueues a stale/missing scope                         |

Each model stores a `data_signature` built from the daily booked sums, the
active-plan signature and (for all) the owned account ids. Label/category
changes do not change it, so the labelling worker does not cause retraining
churn. Category shares are computed live at forecast time from booked
expenses not already represented by an active plan.

The drain is sequential, yields between scopes with `setImmediate`, and
contains failures per scope: the row records `failed`, `last_error`, the
attempt count and an exponential backoff up to one hour. A wakeup timer
retries at `next_retry_at` (re-armed on startup); explicit import/plan/account
triggers bypass the backoff. Forecast reads never wait for training: they
return the current artifact or the daily baseline, with `pending` while a
refresh is queued or scheduled and `retryAt` naming the backoff instant.

## API

Only one endpoint:

| Method & path                              | Purpose                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/predictions/forecast?accountId=` | Always returns the two-month daily/monthly prediction; `source: "model" \| "baseline"`, `pending`, `retryAt`; 400 `invalid_account` |

The response’s `monthly` bucket is the current month remainder plus the next
calendar month; each month also exposes `bookedFuture` (certain already-booked
future rows) so a filtered analytics view that omits those rows can still
show them. `daily` carries every chart forecast day from today (predicted
residual plus plans), and `projectedBalance` is the **daily** running balance
including booked future rows, starting today. The dashboard charts
consume `monthly`/`projectedBalance`; `daily` is part of the wire contract for
daily consumers and tests. There is no training or model-management API.

## Performance and runtime

- CPU-only TypeScript; no new dependency, GPU, Python or ONNX runtime.
- Training reads at most `MAX_TRAINING_DAYS = 1095` days per scope and skips
  scopes with fewer than 28 observed days.
- The Tweedie fits and bake-off are tiny for local bank data. Measured on the
  local reference dataset (1,394 days): about 0.1 s for the full two-direction
  bake-off; the daily hurdle/GBDT alternatives were slower and no more
  accurate at this scale.
- If training later outgrows this, the model sits behind the artifact
  boundary; a worker thread or ONNX/LightGBM runner can be added without
  changing the API or charts.

## Tests

`tests/prediction-model.test.ts` (tiers, determinism, recursive horizon),
`tests/prediction-forecast.test.ts` (two-month arithmetic, plans, future
booked rows, scopes), `tests/prediction-automatic.test.ts` (automatic
training, signatures, recovery, retry timer, queue), `tests/predictions-api.test.ts`
(route contract), `tests/dashboard-prediction.test.tsx` (always-on charts),
`tests/prediction-refetch.test.ts` (pending/`retryAt` polling + plural copy),
`tests/plan-prediction-trigger.test.ts` (plan-route trigger fan-out),
`tests/trigger-fanout.test.ts` (account/agent trigger fan-out),
`tests/trigger-besteffort.test.ts` (trigger failures are logged, never fatal),
`tests/prediction-hook-refetch.test.tsx` (hook polling across an account switch),
`tests/prediction-scheduler-guards.test.ts` (startup/retry guards).
