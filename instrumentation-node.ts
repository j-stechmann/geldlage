/**
 * Node.js-only instrumentation (schema init + recovery + label worker).
 * Imported conditionally from instrumentation.ts so the Edge bundle never
 * touches better-sqlite3.
 */
export async function registerNode() {
  const g = globalThis as unknown as { __geldlageInstrumented?: boolean }
  if (g.__geldlageInstrumented) return
  g.__geldlageInstrumented = true

  const { ensureSchema } = await import("@/lib/db")
  const { resetStuckBatches } = await import("@/lib/import/pipeline")
  const { startLabelWorker } = await import("@/lib/labeller/worker")
  const { startPredictionScheduler } =
    await import("@/lib/prediction/scheduler")

  warnIfPlaintext()
  logFilePermissionAdvice()

  try {
    ensureSchema()
    const stuck = resetStuckBatches()
    if (stuck > 0) {
      console.log(`[startup] reset ${stuck} stuck import batch(es) to failed`)
    }
  } catch (err) {
    console.error("[startup] schema/recovery failed:", err)
  }

  // label worker resumes 'labeling' batches after a restart and drains
  // pending/failed rows; first tick shortly after boot (self-heal)
  startLabelWorker()
  // automatic daily prediction models are repaired and refreshed in the
  // background; the charts fall back to the daily baseline until ready
  try {
    startPredictionScheduler()
  } catch (error) {
    console.error("[startup] prediction scheduler failed:", error)
  }
}

/**
 * Bank data (IBANs, counterparty names, full history) rides on every page
 * and API response. Plain HTTP means any same-network guest can read that
 * traffic or inject scripts into served pages — ADR-0031's "silent failure"
 * mode. Next always reports an internal http:// request URL, so the
 * transport is judged from the deployment config: APP_ORIGIN https → TLS in
 * front; NODE_ENV=development is exempt (localhost dev); everything else
 * gets a loud warning so an exposed-HTTP deployment is at least not silent.
 */
function warnIfPlaintext() {
  const origin = process.env.APP_ORIGIN
  if (!origin || origin.startsWith("https://")) return
  console.warn(
    `[startup] WARNING: APP_ORIGIN is not HTTPS (${origin}) — ` +
      "sessions, OIDC tokens and all bank data will travel in plaintext " +
      "and the served app is script-injectable by anyone on the network. " +
      "Put TLS (reverse proxy) in front and keep APP_ORIGIN https://"
  )
  if (process.env.NODE_ENV === "development") return
  console.warn(
    "[startup] WARNING: running without HTTPS indicators in production mode — " +
      "this app handles bank data and must not be served over plain HTTP " +
      "to untrusted networks"
  )
}

/**
 * File-mode SQLite + .env hold plaintext financial data and the session
 * secret; on a multi-user host they must be owner-only (the Docker posture
 * already isolates them — USER node, chowned volume).
 */
function logFilePermissionAdvice() {
  if (process.env.DATABASE_PATH?.includes(":memory:")) return
  console.log(
    "[startup] reminder: keep the database directory (data/) and .env " +
      "readable only by the app's user (umask 077 / chmod 600) on " +
      "multi-user hosts"
  )
}
