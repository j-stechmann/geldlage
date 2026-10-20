"use client"

import * as React from "react"

/**
 * Column model and persisted visibility state of the transactions table.
 *
 * Visibility lives in localStorage (`geldlage.table.columns`), exposed as an
 * external store via useSyncExternalStore — the same pattern as
 * components/agent/panel-state.ts. The server snapshot is fixed to
 * DEFAULT_VISIBLE, so SSR and the hydration render agree while the browser
 * picks up the persisted config right after hydration — no hydration
 * mismatch, no setState in effect. Cross-tab `storage` events are picked up
 * too (new: the previous implementation read localStorage only at mount).
 */

export type ColumnKey =
  | "bookingDate"
  | "valueDate"
  | "status"
  | "counterparty"
  | "purpose"
  | "counterpartyIban"
  | "type"
  | "account"
  | "category"
  | "creditorId"
  | "mandateRef"
  | "customerRef"
  | "labelStatus"
  | "amountCents"

interface ColumnDef {
  key: ColumnKey
  label: string
  defaultOn: boolean
}

export const COLUMNS: readonly ColumnDef[] = [
  { key: "bookingDate", label: "Buchung", defaultOn: true },
  { key: "valueDate", label: "Wertstellung", defaultOn: false },
  { key: "status", label: "Status", defaultOn: false },
  { key: "counterparty", label: "Vertragspartner", defaultOn: true },
  { key: "purpose", label: "Verwendungszweck", defaultOn: true },
  { key: "counterpartyIban", label: "IBAN", defaultOn: false },
  { key: "type", label: "Typ", defaultOn: true },
  { key: "account", label: "Konto", defaultOn: true },
  { key: "category", label: "Kategorie", defaultOn: true },
  { key: "labelStatus", label: "Label-Status", defaultOn: false },
  { key: "creditorId", label: "Gläubiger-ID", defaultOn: false },
  { key: "mandateRef", label: "Mandatsreferenz", defaultOn: false },
  { key: "customerRef", label: "Kundenreferenz", defaultOn: false },
  { key: "amountCents", label: "Betrag", defaultOn: true },
]

const DEFAULT_VISIBLE = COLUMNS.filter((c) => c.defaultOn).map((c) => c.key)

const STORAGE_KEY = "geldlage.table.columns"

const columnListeners = new Set<() => void>()

/**
 * Fallback for environments where localStorage writes throw (Safari private
 * mode, quota exceeded): keeps the last attempted value so the toggle still
 * applies for the session. Successful writes clear it again, so localStorage
 * becomes authoritative once more. Note that while an override exists it
 * shadows localStorage, including cross-tab `storage` updates, which is
 * acceptable for this edge case.
 */
let inMemoryOverride: string | null = null

function subscribeColumns(callback: (event?: StorageEvent) => void) {
  columnListeners.add(callback)
  const onStorage = (event: StorageEvent) => {
    // react to our key, or to a clear() (which emits key === null);
    // some older Safari versions report null storageArea, so only trust
    // it when it is present
    if (
      (event.storageArea === null || event.storageArea === localStorage) &&
      (event.key === STORAGE_KEY || event.key === null)
    ) {
      callback(event)
    }
  }
  window.addEventListener("storage", onStorage)
  return () => {
    columnListeners.delete(callback)
    window.removeEventListener("storage", onStorage)
  }
}

function getColumnSnapshot(): string {
  if (inMemoryOverride !== null) return inMemoryOverride
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

function getServerColumnSnapshot(): string {
  return ""
}

function notifyColumns() {
  for (const listener of columnListeners) {
    listener()
  }
}

// module-scope mutation must go through this helper so the react-hooks
// "globals" rule doesn't flag the component for reassigning outer state
function setColumnOverride(json: string | null) {
  inMemoryOverride = json
}

/** Parse a stored visibility JSON into the visible-column list. */
function parseVisible(json: string): ColumnKey[] {
  if (!json) return DEFAULT_VISIBLE
  try {
    const parsed = JSON.parse(json) as ColumnKey[]
    const valid = parsed.filter((k) => COLUMNS.some((c) => c.key === k))
    return valid.length > 0 ? valid : DEFAULT_VISIBLE
  } catch {
    return DEFAULT_VISIBLE
  }
}

/** The persisted visible columns: defaults during SSR and hydration. */
export function useVisibleColumns(): ColumnKey[] {
  const json = React.useSyncExternalStore(
    subscribeColumns,
    getColumnSnapshot,
    getServerColumnSnapshot
  )
  return React.useMemo(() => parseVisible(json), [json])
}

/**
 * Toggle one column's visibility and persist it. The store owns the
 * read-modify-write — callers only pass the key and stay ignorant of the
 * storage internals (override fallback, event fan-out, canonical order).
 */
export function toggleColumn(key: ColumnKey) {
  const prev = parseVisible(getColumnSnapshot())
  const next = prev.includes(key)
    ? prev.filter((k) => k !== key)
    : [
        ...COLUMNS.map((c) => c.key).filter(
          (k) => prev.includes(k) || k === key
        ),
      ]
  if (next.length === 0) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    // a previously failed write may have left an override; the persisted
    // value is now authoritative again
    setColumnOverride(null)
  } catch {
    // keep the change in memory so the toggle still applies when the
    // write throws (quota / blocked storage)
    setColumnOverride(JSON.stringify(next))
  } finally {
    notifyColumns()
  }
}
