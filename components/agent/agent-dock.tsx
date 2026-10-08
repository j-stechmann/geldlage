"use client"

import { useEffect, useRef, useState } from "react"
import {
  clampWidth,
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

  if (!isDesktop) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col border-l bg-background shadow-lg md:hidden">
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
      </div>
    )
  }

  return (
    <aside
      data-slot="agent-dock"
      style={{ width }}
      className="sticky top-14 flex h-[calc(100svh-3.5rem)] flex-none flex-col border-l bg-background"
    >
      <ResizeHandle />
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
 * and persisted by setPanelState on every move.
 */
function ResizeHandle() {
  const dragging = useRef(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const dockLeft = e.currentTarget.parentElement?.getBoundingClientRect().left
    if (dockLeft === undefined) return
    setPanelState({ width: clampWidth(dockLeft - e.clientX) })
  }
  const onPointerUp = () => {
    dragging.current = false
  }

  return (
    <div
      aria-hidden
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "absolute top-0 left-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize",
        "hover:bg-border focus-visible:bg-ring"
      )}
    />
  )
}
