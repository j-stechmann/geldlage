"use client"

import { useState } from "react"
import { Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Tool round chip (ADR-0033): name + expandable JSON args/result. Shared
 * by persisted message rows and the in-flight streaming bubble — exactly
 * one place that renders tool activity.
 */

export function ToolChip(props: {
  name: string
  args: string
  result: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <Button
        variant="ghost"
        size="xs"
        className="text-xs text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <Wrench className="size-3" />
        {props.name}
      </Button>
      {open && (
        <div className="mt-1 max-h-40 overflow-auto rounded-md border bg-background p-2">
          {props.args && <pre className="text-xs">{props.args}</pre>}
          {props.result && (
            <pre className="text-xs">{formatToolResult(props.result)}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/** Pretty-prints the JSON tool result; falls back to raw text. */
function formatToolResult(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
