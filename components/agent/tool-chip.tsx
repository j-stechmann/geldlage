"use client"

import { useState } from "react"
import { Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/agent/markdown"

/**
 * Tool round chip (ADR-0033): name + expandable JSON args/result. Shared
 * by persisted message rows and the in-flight streaming bubble — exactly
 * one place that renders tool activity.
 *
 * Payloads render through the shared markdown renderer as fenced blocks
 * (json language → highlight.js): the fence preserves the formatted
 * whitespace the plain `<pre>` showed, and fence length adapts so a
 * payload containing backticks can never terminate the fence early.
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
          {props.args && <Markdown text={asCodeBlock("json", props.args)} />}
          {props.result && (
            <Markdown
              text={asCodeBlock("json", formatToolResult(props.result))}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Wraps text in a markdown fence longer than any backtick run in it. */
function asCodeBlock(lang: string, raw: string): string {
  const runs = raw.match(/`+/g)
  const fence = "`".repeat(
    Math.max(3, ...(runs ?? []).map((r) => r.length + 1))
  )
  return `${fence}${lang}\n${raw}\n${fence}`
}

/** Pretty-prints the JSON tool result; falls back to raw text. */
function formatToolResult(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
