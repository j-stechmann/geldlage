"use client"

import * as React from "react"

// pointer movement (px) above which a click on a row counts as a drag
// (e.g. text selection) instead of an activation
const DRAG_THRESHOLD = 4

interface PointerDownState {
  x: number
  y: number
  /** a text selection already existed inside the row at press time */
  hadSelection: boolean
}

export interface RowActivation {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  /**
   * consumes the pointer-down state recorded for this press; returns true
   * if the click is a plain activation. Call at most once per click.
   */
  isPlainClick: (e: React.MouseEvent<HTMLElement>) => boolean
}

/**
 * Activation check for clickable rows whose content is also selectable
 * (transactions table: clicking a row toggles its detail row, but dragging
 * a text selection across it must not).
 *
 * One hook instance per table: it owns the single pointer-down record that
 * every row shares (each press overwrites it, and the click that follows
 * always finds the record of its own press — including clicks on row
 * children, which bubble). Gate the row's action on its verdict:
 *
 *   <tr onPointerDown={activation.onPointerDown}
 *       onClick={(e) => activation.isPlainClick(e) && toggle(row.id)}>
 */
export function useRowActivation(): RowActivation {
  const pointerDownRef = React.useRef<PointerDownState | null>(null)

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // record where the press started and whether a text selection already
      // existed inside the row — Firefox keeps the old selection when
      // clicking inside it, so a plain click there must still toggle (see
      // isPlainClick)
      const selection = window.getSelection()
      pointerDownRef.current = {
        x: e.clientX,
        y: e.clientY,
        hadSelection:
          selection != null &&
          !selection.isCollapsed &&
          (e.currentTarget.contains(selection.anchorNode) ||
            e.currentTarget.contains(selection.focusNode)),
      }
    },
    []
  )

  const isPlainClick = React.useCallback((e: React.MouseEvent<HTMLElement>) => {
    // a double-click dispatches a second click that carries detail === 2;
    // ignore it so a double-click (e.g. for word selection while copying)
    // doesn't toggle twice — the first click still toggles once
    if (e.detail > 1) return false
    const down = pointerDownRef.current
    pointerDownRef.current = null
    // once the pointer has moved this is a drag (e.g. selecting text),
    // never an activation
    if (
      down &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_THRESHOLD
    ) {
      return false
    }
    // a sub-threshold drag can still end with a fresh text selection;
    // check both ends, since drags that end inside the row put the anchor
    // in a different row. A click that lands inside a pre-existing
    // selection (down.hadSelection) without moving was a plain click and
    // still toggles, even though Firefox keeps that selection alive.
    const selection = window.getSelection()
    if (
      selection &&
      !selection.isCollapsed &&
      !down?.hadSelection &&
      (e.currentTarget.contains(selection.anchorNode) ||
        e.currentTarget.contains(selection.focusNode))
    ) {
      return false
    }
    return true
  }, [])

  // stable object identity so memoized rows may take it as one prop
  return React.useMemo(
    () => ({ onPointerDown, isPlainClick }),
    [onPointerDown, isPlainClick]
  )
}
