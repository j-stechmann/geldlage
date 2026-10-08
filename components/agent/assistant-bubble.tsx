"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { ToolChip } from "@/components/agent/tool-chip"
import type { ToolEvent } from "@/components/agent/types"

/**
 * The ONE assistant bubble (ADR-0033): reasoning toggle ("Denkprozess"),
 * tool chips and streamed/persisted content. Previously the persisted row
 * and the streaming bubble were two near-identical components drifting
 * apart; now streaming only toggles defaults (thinking open, cursor) —
 * markup lives once.
 */

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
            <p className="mb-1.5 border-l-2 pl-2 text-xs whitespace-pre-wrap text-muted-foreground italic">
              {props.reasoning}
            </p>
          )}
          {(props.tools ?? []).map((t, i) => (
            <ToolChip
              key={i}
              name={t.name}
              args={t.kind === "tool_call" ? t.payload : ""}
              result={t.kind === "tool_result" ? t.payload : ""}
            />
          ))}
          <p className="whitespace-pre-wrap">
            {props.content}
            {props.streaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/70 align-middle" />
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
