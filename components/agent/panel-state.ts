"use client"

import { useSyncExternalStore } from "react"

/**
 * Panel state for the agent dock (ADR-0033): open + width, module-level so
 * the header toggle and the dock share it without a provider, persisted to
 * localStorage. SSR serves the fixed default; the first client read
 * hydrates from localStorage (lazy — no effect needed).
 */

const OPEN_KEY = "geldlage.agent.open"
const WIDTH_KEY = "geldlage.agent.width"

const MIN_WIDTH = 280
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 360

interface PanelState {
  open: boolean
  width: number
}

let state: PanelState = { open: false, width: DEFAULT_WIDTH }

function clampWidth(w: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))
}

function hydrate() {
  if (typeof window === "undefined") return
  const open = window.localStorage.getItem(OPEN_KEY)
  const width = Number.parseInt(
    window.localStorage.getItem(WIDTH_KEY) ?? "",
    10
  )
  state = {
    open: open === "1",
    width: Number.isFinite(width) ? clampWidth(width) : DEFAULT_WIDTH,
  }
}

/**
 * useSyncExternalStore's getSnapshot must return a stable value between
 * renders — the lazy hydrate runs exactly once on the first client call
 * and mutates the module state in place.
 */
let hydrated = false

function getSnapshot(): PanelState {
  if (!hydrated) {
    hydrated = true
    hydrate()
  }
  return state
}

export function setPanelState(partial: Partial<PanelState>) {
  state = { ...state, ...partial }
  if (typeof window !== "undefined") {
    window.localStorage.setItem(OPEN_KEY, state.open ? "1" : "0")
    window.localStorage.setItem(WIDTH_KEY, String(state.width))
  }
  for (const listener of listeners) listener()
}

export function togglePanel() {
  setPanelState({ open: !state.open })
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePanelState(): PanelState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** SSR snapshot: the panel never starts open (no layout flash). Cached so
 * useSyncExternalStore gets a stable reference (React warns + can loop
 * when getServerSnapshot allocates a new object each call). */
const SERVER_SNAPSHOT: PanelState = { open: false, width: DEFAULT_WIDTH }

function getServerSnapshot(): PanelState {
  return SERVER_SNAPSHOT
}

export { MIN_WIDTH, MAX_WIDTH, clampWidth }
