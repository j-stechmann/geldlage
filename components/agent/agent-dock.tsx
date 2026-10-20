"use client"

import { useEffect, useRef, useState } from "react"
import {
  clampWidth,
  MAX_WIDTH,
  MIN_WIDTH,
  previewPanelState,
  setPanelState,
  usePanelState,
} from "@/components/agent/panel-state"
import { AgentChat } from "@/components/agent/agent-chat"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Right-side agent dock (ADR-0033): a resizable flex column docked next to
 * the page content on desktop (md+), a full-screen overlay below md. The
 * frame only owns resize/positioning — the chat itself lives in AgentChat.
 */
export function AgentDock() {
  const { open, width } = usePanelState()
  // Read the breakpoint synchronously on first render, not in an effect:
  // with the panel persisted open, a mobile visitor would otherwise paint
  // the docked <aside> once before matchMedia flips post-paint. Safe even
  // with SSR — the dock renders null until the client store hydrates
  // (open defaults false), so the initializer only ever runs client-side.
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window === "undefined" ||
      window.matchMedia("(min-width: 768px)").matches
  )

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)")
    const apply = () => setIsDesktop(mq.matches)
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])

  if (!open) return null

  // ONE root element for both breakpoints: swapping <div> ↔ <aside> at
  // the md boundary would unmount the whole subtree (React reconciles
  // by element type), aborting an in-flight turn via useAgentTurn's
  // unmount cleanup — a resize across 768px mid-stream would silently
  // kill the answer. Only classes and the width style differ, so
  // AgentChat and its streaming state survive the crossing.
  return (
    <aside
      data-slot="agent-dock"
      style={isDesktop ? { width } : undefined}
      className={
        isDesktop
          ? // max-w keeps the dock from outgrowing the viewport: the page
            // always keeps MIN_PAGE_WIDTH beside it, so a persisted 720px
            // width can't squeeze main to a sliver on a small window. Pure
            // CSS — window resizes re-apply the cap with no listener and
            // leave the persisted width untouched (it restores when the
            // window grows again); drag/keyboard resize instead clamp to
            // and commit the cap. 320px (not 20rem) so the CSS bound and
            // the ResizeHandle's MIN_PAGE_WIDTH stay the same constant
            // even if the root font-size ever changes.
            "sticky top-14 flex h-[calc(100svh-3.5rem)] max-w-[calc(100vw-320px)] flex-none flex-col border-l bg-background"
          : "fixed inset-0 z-50 flex flex-col border-l bg-background shadow-lg"
      }
    >
      {isDesktop && <ResizeHandle />}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-semibold">KI-Chat</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Chat schließen"
          onClick={() => setPanelState({ open: false })}
        >
          <X className="size-4" />
        </Button>
      </div>
      <AgentChat />
    </aside>
  )
}

/**
 * Drag-to-resize handle on the dock's left edge: pointer capture keeps the
 * drag alive outside the strip, width is clamped to [MIN_WIDTH, MAX_WIDTH]
 * and to the viewport (the page keeps MIN_PAGE_WIDTH beside the dock) and
 * persisted by setPanelState once on pointerup — the moves in between
 * only preview the width in memory (a synchronous localStorage write per
 * pointermove would fire dozens of times per drag). The drag is anchored
 * at pointerdown — pointer X and dock width are frozen there and the
 * width is derived from the pointer delta, not the live rect (the aside's
 * left edge moves with every committed width, so reading it per-move
 * would feed the last width back into the next one).
 *
 * Keyboard support (WAI-ARIA separator pattern): the strip is a focusable
 * separator; ArrowLeft/ArrowRight move the edge by RESIZE_KEY_STEP in the
 * drag's direction (the handle is on the LEFT edge, so left = wider),
 * Home/End clamp to the bounds.
 */
const RESIZE_KEY_STEP = 16

/**
 * The page keeps at least 320px beside the dock. Must stay the exact value
 * the aside's `max-w-[calc(100vw-320px)]` class subtracts — px, not rem, so
 * the CSS bound and this bound stay equal even if the root font-size ever
 * changes. Caveat: `100vw`/`window.innerWidth` both include the vertical
 * scrollbar, so when the cap is active on a scrollable page the space
 * beside the dock falls the scrollbar's width short of the full 320px.
 * (jsdom aside: drag/keyboard resize clamps to the same limit so the
 * previewed width matches what renders; only meaningful on md+ where the
 * dock is docked — the overlay below md has no resize handle.)
 */
const MIN_PAGE_WIDTH = 320

function viewportMaxWidth(): number {
  return window.innerWidth - MIN_PAGE_WIDTH
}

function clampResizableWidth(w: number): number {
  return Math.min(clampWidth(w), viewportMaxWidth())
}

function ResizeHandle() {
  const { width } = usePanelState()
  const drag = useRef<{
    startX: number
    startWidth: number
    width: number
  } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement
    if (!parent) return
    // clamp against the viewport too: a persisted 720px on a since-shrunk
    // window would anchor the drag at a width the aside no longer renders
    const startWidth = clampResizableWidth(parent.getBoundingClientRect().width)
    drag.current = { startX: e.clientX, startWidth, width: startWidth }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start) return
    start.width = clampResizableWidth(
      start.startWidth + (start.startX - e.clientX)
    )
    previewPanelState({ width: start.width })
  }
  // pointer capture funnels up/cancel here even outside the strip: one
  // persist per drag (skipped when it never started)
  const endDrag = () => {
    const start = drag.current
    drag.current = null
    if (start) setPanelState({ width: start.width })
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // preventDefault suppresses the arrow keys' native scroll behavior
    if (e.key === "ArrowLeft") {
      e.preventDefault()
      setPanelState({ width: clampResizableWidth(width + RESIZE_KEY_STEP) })
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      setPanelState({ width: clampResizableWidth(width - RESIZE_KEY_STEP) })
    } else if (e.key === "Home") {
      e.preventDefault()
      setPanelState({ width: MIN_WIDTH })
    } else if (e.key === "End") {
      e.preventDefault()
      // End = "widest allowed", which on a small window is the viewport
      // cap, not the absolute MAX_WIDTH
      setPanelState({ width: clampResizableWidth(MAX_WIDTH) })
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Breite des Chats ändern"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        "absolute top-0 left-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize",
        "hover:bg-border focus-visible:bg-ring"
      )}
    />
  )
}
