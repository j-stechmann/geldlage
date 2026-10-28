/**
 * Local calendar date of a Date (YYYY-MM-DD) — the general form of
 * todayLocal(). Not UTC-based: toISOString() shifts the date for timezones
 * east of UTC before noon / west after noon, which would name the wrong
 * calendar day.
 */
export function isoDateLocal(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/**
 * Local calendar date (YYYY-MM-DD). Not UTC-based: `toISOString()` shifts
 * the date for timezones east of UTC before noon / west after noon, which
 * would name the wrong "current month" around month boundaries.
 */
export function todayLocal(): string {
  return isoDateLocal(new Date())
}
