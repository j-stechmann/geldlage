"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ToolChip } from "@/components/agent/tool-chip"
import { AssistantBubble } from "@/components/agent/assistant-bubble"
import type {
  StoredMessage,
  ThreadDetail,
  ToolEvent,
} from "@/components/agent/types"

/** Stable empty identity keeps the multi-author memo dependency-safe. */
const EMPTY: StoredMessage[] = []

/**
 * Message list (ADR-0033): persisted rows + optimistic pending user
 * message + the streaming bubble, pinned to the bottom. Handles the two
 * special views: no thread (empty state) and invited preview (join panel
 * — the detail query 404s for invited users by design).
 */

interface MessageListProps {
  data: ThreadDetail | undefined
  hasError: boolean
  activeThreadId: string
  streaming: boolean
  streamContent: string
  streamReasoning: string
  streamTools: ToolEvent[]
  pendingUserMessage: string | null
  namesById: Map<number, string>
  invitedTitle: string | undefined
  onJoin: (id: string) => Promise<void>
  onDecline: (id: string) => Promise<void>
  /** Changes whenever the list should re-pin to the bottom (message count or streaming). */
  pinTarget: string
}

export function MessageListView(props: MessageListProps) {
  // pin-to-bottom via callback ref + state (same pattern as
  // hooks/use-chart-zoom): the effect reads state, never a ref in render.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (listEl) listEl.scrollTo({ top: listEl.scrollHeight })
  }, [listEl, props.pinTarget])

  if (!props.activeThreadId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Stell eine Frage zu deinen Finanzdaten…
      </div>
    )
  }
  // invited users get the join panel instead of messages (404 by design —
  // "preview after join"): the title comes from the threads list
  if (props.hasError || !props.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          Einladung zu „{props.invitedTitle ?? "Chat"}“.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => props.onJoin(props.activeThreadId)}>
            Annehmen
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onDecline(props.activeThreadId)}
          >
            Ablehnen
          </Button>
        </div>
      </div>
    )
  }

  // The invited panel above catches hasError; a transient undefined
  // between refetch cycles would still crash here — render empty rather
  // than throw (the next poll fills it in).
  const data = props.data
  const messages = data?.messages ?? EMPTY
  const multiAuthor =
    new Set(messages.filter((m) => m.userId !== null).map((m) => m.userId))
      .size > 1

  return (
    <div ref={setListEl} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="flex flex-col gap-2.5">
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            message={m}
            namesById={props.namesById}
            showAuthor={multiAuthor}
          />
        ))}
        {props.pendingUserMessage && (
          <div className="flex justify-end">
            <UserBubble content={props.pendingUserMessage} />
          </div>
        )}
        {props.streaming && (
          <AssistantBubble
            content={props.streamContent}
            reasoning={props.streamReasoning}
            tools={props.streamTools}
            streaming
          />
        )}
      </div>
    </div>
  )
}

function MessageRow(props: {
  message: StoredMessage
  namesById: Map<number, string>
  showAuthor: boolean
}) {
  const m = props.message
  if (m.role === "tool")
    return (
      <ToolChip
        name={m.toolName ?? "tool"}
        args={m.toolArgs ?? ""}
        result={m.content}
      />
    )
  if (m.role === "user") {
    const author = props.showAuthor
      ? (props.namesById.get(m.userId ?? -1) ?? "?")
      : null
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          {author && (
            <p className="mb-0.5 text-right text-[0.7rem] text-muted-foreground">
              {author}
            </p>
          )}
          <UserBubble content={m.content} />
        </div>
      </div>
    )
  }
  return <AssistantBubble content={m.content} reasoning={m.reasoning} />
}

function UserBubble(props: { content: string }) {
  return (
    <div className="rounded-xl rounded-br-sm bg-primary px-3 py-1.5 text-sm whitespace-pre-wrap text-primary-foreground">
      {props.content}
    </div>
  )
}
