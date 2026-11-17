"use client"

import * as React from "react"

const DEBOUNCE_MS = 300

/**
 * Debounced search draft shared by the transactions FilterBar and the plans
 * list (ADR-0037).
 *
 * - the draft is emitted trimmed after a fixed debounce;
 * - an external `value` change (back/forward, shared link) resyncs the draft
 *   unless it is our own just-emitted value;
 * - `commitNow` cancels a pending timer and emits synchronously (the plans
 *   reset button must clear the applied filter immediately);
 * - `cancel` drops a pending emit without emitting (the FilterBar reset
 *   supplies the full replacement state itself).
 *
 * `onCommit` is held in a ref so callers can pass an inline closure without
 * restarting the timer on every filter change.
 */
export function useDebouncedSearch(
  value: string,
  onCommit: (next: string) => void
) {
  const [draft, setDraft] = React.useState(value)
  const lastEmitted = React.useRef(value)
  const lastSynced = React.useRef(value)
  const onCommitRef = React.useRef(onCommit)
  React.useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // External value resync: an own debounced emit is already in the draft.
  React.useEffect(() => {
    if (value === lastSynced.current) return
    lastSynced.current = value
    if (value !== lastEmitted.current) {
      lastEmitted.current = value
      setDraft(value)
    }
  }, [value])

  React.useEffect(() => {
    timerRef.current = setTimeout(() => {
      const q = draft.trim()
      if (q !== lastEmitted.current) {
        lastEmitted.current = q
        onCommitRef.current(q)
      }
    }, DEBOUNCE_MS)
    return cancel
  }, [draft, cancel])

  const commitNow = React.useCallback(
    (next: string) => {
      cancel()
      lastEmitted.current = next
      setDraft(next)
      onCommitRef.current(next)
    },
    [cancel]
  )

  return { draft, setDraft, commitNow, cancel }
}
