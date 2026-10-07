"use client"

import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"
import { ThreadBar } from "@/components/agent/thread-bar"
import { MessageListView } from "@/components/agent/message-list"
import { ChatInput } from "@/components/agent/chat-input"
import { InviteDialog } from "@/components/agent/invite-dialog"
import { useAgentThreads } from "@/components/agent/use-agent-threads"
import { useAgentTurn } from "@/components/agent/use-agent-turn"
import {
  deleteOrLeaveThread,
  joinThread,
  renameThread,
  invite,
} from "@/components/agent/agent-api"
import type { Member } from "@/components/agent/types"

/**
 * Agent chat orchestrator (ADR-0033): composes the thread bar, message
 * list, composer and invite dialog around two hooks (use-agent-threads,
 * use-agent-turn). All server calls live in agent-api; markup lives in
 * the leaf components — this file owns only composition and the mutation
 * handlers with their German toasts.
 */

const EMPTY_MESSAGES: Array<{
  id: string
  userId: number | null
  role: "user" | "assistant" | "tool"
  content: string
  reasoning: string | null
  toolName: string | null
  toolArgs: string | null
  createdAt: string
  threadSeq: number
}> = []
const EMPTY_MEMBERS: Member[] = []

export function AgentChat() {
  const [renaming, setRenaming] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [input, setInput] = useState("")

  // Order matters for hooks but not for dataflow: useAgentTurn owns the
  // streaming flag; useAgentThreads consumes it (pauses detail polling
  // while a turn is in flight) and exposes the ids the turn hook needs —
  // the turn's send takes the thread id per call, so there is no cycle.
  const { streaming, streams, pendingUserMessage, send, stop } = useAgentTurn()
  const {
    detailQuery,
    threads,
    activeThreadId,
    activeThread,
    setActiveThreadId,
    createThread: createThreadAndSelect,
    refresh,
  } = useAgentThreads(streaming)

  const detail = detailQuery.data
  const role = detail?.role
  const messages = detail?.messages ?? EMPTY_MESSAGES
  const members: Member[] = detail?.members ?? EMPTY_MEMBERS

  // Name resolution for user messages in (potentially shared) threads.
  const namesById = useMemo(() => {
    const m = new Map<number, string>()
    for (const mem of members) m.set(mem.userId, mem.name)
    return m
  }, [members])

  const mine = useMemo(
    () => threads.filter((t) => t.role === "owner"),
    [threads]
  )
  const joined = useMemo(
    () => threads.filter((t) => t.role === "member"),
    [threads]
  )
  const invited = useMemo(
    () => threads.filter((t) => t.role === "invited"),
    [threads]
  )

  const handleSend = useCallback(async () => {
    const content = input.trim()
    if (!content || streaming) return
    setInput("")
    let threadId = activeThreadId
    if (!threadId) {
      threadId = (await createThreadAndSelect()) ?? ""
      if (!threadId) return
    }
    await send(threadId, content)
  }, [activeThreadId, createThreadAndSelect, input, send, streaming])

  const onRename = useCallback(
    async (title: string) => {
      if (!activeThreadId) return
      const ok = await renameThread(activeThreadId, title)
      if (!ok) {
        toast.error("Umbenennen fehlgeschlagen (1–80 Zeichen).")
        return
      }
      setRenaming(false)
      refresh()
    },
    [activeThreadId, refresh]
  )

  const onInvite = useCallback(
    async (userIds: number[]) => {
      if (!activeThreadId) return
      const count = await invite(activeThreadId, userIds)
      if (count === null) {
        toast.error("Einladung fehlgeschlagen.")
        return
      }
      toast.success(
        count === 1 ? "1 Einladung gesendet." : `${count} Einladungen gesendet.`
      )
      setInviteOpen(false)
      refresh(activeThreadId)
    },
    [activeThreadId, refresh]
  )

  const onDelete = useCallback(async () => {
    if (!activeThreadId) return
    if (!(await deleteOrLeaveThread(activeThreadId))) {
      toast.error("Löschen fehlgeschlagen.")
      return
    }
    setActiveThreadId("")
    refresh()
    toast.success("Chat gelöscht.")
  }, [activeThreadId, refresh, setActiveThreadId])

  const onLeave = useCallback(async () => {
    if (!activeThreadId) return
    if (!(await deleteOrLeaveThread(activeThreadId))) {
      toast.error("Verlassen fehlgeschlagen.")
      return
    }
    setActiveThreadId("")
    refresh()
  }, [activeThreadId, refresh, setActiveThreadId])

  const onJoin = useCallback(
    async (threadId: string) => {
      const ok = await joinThread(threadId)
      if (!ok) {
        toast.error("Beitreten fehlgeschlagen — Einladung wurde entfernt.")
        refresh()
        return
      }
      toast.success("Beigetreten.")
      setActiveThreadId(threadId)
      refresh()
    },
    [refresh, setActiveThreadId]
  )

  const onDecline = useCallback(
    async (threadId: string) => {
      const ok = await deleteOrLeaveThread(threadId)
      if (ok) refresh()
    },
    [refresh]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadBar
        activeThread={activeThread}
        mine={mine}
        joined={joined}
        invited={invited}
        role={role}
        renaming={renaming}
        onSelect={setActiveThreadId}
        onCreate={createThreadAndSelect}
        onRename={onRename}
        onStartRename={() => setRenaming(true)}
        onInviteOpen={() => setInviteOpen(true)}
        onDelete={onDelete}
        onLeave={onLeave}
        onJoin={onJoin}
        onDecline={onDecline}
      />
      <MessageListView
        data={detailQuery.data}
        hasError={Boolean(detailQuery.error)}
        activeThreadId={activeThreadId}
        streaming={streaming}
        streamContent={streams.content}
        streamReasoning={streams.reasoning}
        streamTools={streams.tools}
        pendingUserMessage={pendingUserMessage}
        namesById={namesById}
        invitedTitle={activeThread?.title}
        onJoin={onJoin}
        onDecline={onDecline}
        pinTarget={streaming ? "stream" : String(messages.length)}
      />
      <ChatInput
        disabled={
          streaming || Boolean(activeThread && activeThread.role === "invited")
        }
        onSend={handleSend}
        onStop={stop}
        streaming={streaming}
        input={input}
        setInput={setInput}
      />
      <InviteDialog
        open={inviteOpen}
        threadId={activeThreadId}
        members={members}
        onInvite={onInvite}
        onClose={() => setInviteOpen(false)}
      />
    </div>
  )
}
