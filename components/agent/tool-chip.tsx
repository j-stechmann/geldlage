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
 * (JSON payloads pretty-printed and tagged `json` → highlight.js): the
 * fence preserves the formatted whitespace the plain `<pre>` showed, and
 * fence length adapts so a payload containing backticks can never
 * terminate the fence early.
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
          {props.args && <Markdown text={asCodeBlock(props.args)} />}
          {props.result && <Markdown text={asCodeBlock(props.result)} />}
        </div>
      )}
    </div>
  )
}

/**
 * Wraps a tool payload in a markdown fence longer than any backtick run
 * in it. Payloads that parse as JSON are pretty-printed and tagged `json`;
 * anything else (the old raw-text fallback) stays a language-less fence —
 * highlighting prose against the JSON grammar would just mis-color it.
 * A language-less fence renders as bare block code in the renderer.
 */
function asCodeBlock(raw: string): string {
  let lang = ""
  try {
    // pretty-print on the same parse that decides the language tag
    raw = JSON.stringify(JSON.parse(raw), null, 2)
    lang = "json"
  } catch {
    // non-JSON payload: leave raw, keep the fence language-less
  }
  const runs = raw.match(/`+/g)
  const fence = "`".repeat(
    Math.max(3, ...(runs ?? []).map((r) => r.length + 1))
  )
  return `${fence}${lang}\n${raw}\n${fence}`
}
