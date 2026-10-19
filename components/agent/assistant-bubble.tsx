"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { ToolChip } from "@/components/agent/tool-chip"
import { Markdown } from "@/components/agent/markdown"
import type { ToolEvent } from "@/components/agent/types"

/**
 * The ONE assistant bubble (ADR-0033): reasoning toggle ("Denkprozess"),
 * tool chips and streamed/persisted content. Previously the persisted row
 * and the streaming bubble were two near-identical components drifting
 * apart; now streaming only toggles defaults (thinking open, cursor) —
 * markup lives once.
 *
 * Content and Denkprozess render through the shared markdown renderer.
 * The streaming cursor is a CSS ::after on the markdown root's last block
 * child (STREAMING_CURSOR): it stays inline with the live text exactly
 * where the old `<p>` cursor sat, without the renderer needing to know
 * about it.
 */

/**
 * Pulsing bar via ::after on the last markdown block (p, pre, …): inline
 * at the end of the live text; the arbitrary variant needs an explicit
 * content in Tailwind v4.
 */
const STREAMING_CURSOR = [
  "[&>*:last-child]:after:content-['']",
  "[&>*:last-child]:after:ml-0.5",
  "[&>*:last-child]:after:inline-block",
  "[&>*:last-child]:after:h-3.5",
  "[&>*:last-child]:after:w-1.5",
  "[&>*:last-child]:after:animate-pulse",
  "[&>*:last-child]:after:bg-foreground/70",
  "[&>*:last-child]:after:align-middle",
].join(" ")

interface AssistantBubbleProps {
  content: string
  reasoning: string | null
  /** In-flight tool rounds (streaming only); omitted for persisted rows. */
  tools?: ToolEvent[]
  /** Streaming indicator: thinking starts open and a cursor pulses. */
  streaming?: boolean
}

export function AssistantBubble(props: AssistantBubbleProps) {
  // persisted rows start collapsed, the streaming bubble open
  const [showThinking, setShowThinking] = useState(props.streaming ?? false)
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <div className="rounded-xl rounded-bl-sm border bg-muted px-3 py-1.5 text-sm">
          {props.reasoning && (
            <button
              className="mb-1 flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
              onClick={() => setShowThinking((s) => !s)}
            >
              {showThinking ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              Denkprozess
            </button>
          )}
          {props.reasoning && showThinking && (
            <div className="mb-1.5 border-l-2 pl-2 text-xs text-muted-foreground italic">
              <Markdown text={props.reasoning} />
            </div>
          )}
          {(props.tools ?? []).map((t, i) => (
            <ToolChip
              key={i}
              name={t.name}
              args={t.kind === "tool_call" ? t.payload : ""}
              result={t.kind === "tool_result" ? t.payload : ""}
            />
          ))}
          {/* Whitespace-only streamed frames parse to zero markdown
              blocks, leaving the ::after cursor without a last-child
              anchor — those frames fall back to the plain-text cursor. */}
          {props.content.trim() === "" && props.streaming ? (
            <p className="whitespace-pre-wrap">
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/70 align-middle" />
            </p>
          ) : (
            <Markdown
              text={props.content}
              className={props.streaming ? STREAMING_CURSOR : undefined}
            />
          )}
        </div>
      </div>
    </div>
  )
}
