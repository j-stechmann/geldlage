/**
 * Distinguishes URL changes caused by this page's own navigations ("echoes")
 * from external ones (back/forward, shared links).
 *
 * The owning component commits filter URLs asynchronously; when such a
 * commit lands in searchParams it must not clobber newer local state.
 */
export type EchoDecision = "own" | "external"

export class UrlEchoRegistry {
  private readonly keys = new Map<string, number>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Register an echo for a URL the component is about to commit. A
   * redundant commit (qs already reflected in the URL) registers nothing —
   * a lingering echo would swallow a later genuine navigation to the same
   * URL.
   */
  add(qs: string, lastUrlKey: string, now = Date.now()): void {
    if (qs === lastUrlKey) return
    this.keys.set(qs, now)
    // evict only stale entries (interrupted/coalesced navigations whose
    // commits never happened), never pending ones — capping by count risks
    // dropping a still-queued echo whose URL later commits
    for (const [key, ts] of this.keys) {
      if (now - ts > this.ttlMs) this.keys.delete(key)
    }
  }

  /**
   * Classify an observed URL change: "own" if it echoes one of our commits
   * (consume it), "external" if it should be adopted as new filter state.
   * Consuming an echo also clears newer keys: they were queued behind a
   * navigation that just committed, so their URL state is already shown.
   */
  consume(urlKey: string): EchoDecision {
    const consumedAt = this.keys.get(urlKey)
    if (consumedAt === undefined) return "external"
    this.keys.delete(urlKey)
    for (const [key, ts] of this.keys) {
      if (ts > consumedAt) this.keys.delete(key)
    }
    return "own"
  }
}
