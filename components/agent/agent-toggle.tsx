"use client"

import { MessagesSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { togglePanel, usePanelState } from "@/components/agent/panel-state"
import { cn } from "@/lib/utils"

/** Header toggle for the agent dock (ADR-0033). */
export function AgentToggle() {
  const { open } = usePanelState()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="KI-Chat öffnen oder schließen"
      aria-pressed={open}
      onClick={togglePanel}
      className={cn(open && "bg-accent text-accent-foreground")}
    >
      <MessagesSquare className="size-4" />
    </Button>
  )
}
