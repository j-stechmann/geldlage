"use client"

import { useCallback, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { ThreadBar } from "@/components/agent/thread-bar"
import { MessageListView } from "@/components/agent/message-list"
import { ChatInput } from "@/components/agent/chat-input"
import { InviteDialog } from "@/components/agent/invite-dialog"
import { useAgentThreads } from "@/components/agent/use-agent-threads"
import { useAgentTurn } from "@/components/agent/use-agent-turn"
import {
  USERS_KEY,
  deleteOrLeaveThread,
  fetchUsers,
  joinThread,
  renameThread,
  invite,
} from "@/components/agent/agent-api"
import type { Member, UserRow } from "@/components/agent/types"

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
  // renamingThreadId doubles as the rename flag: it carries WHICH thread is
  // being renamed, so a thread switch mid-rename cannot retarget the submit
  // (the editor applies its draft to the id captured at pencil-click time).
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [input, setInput] = useState("")

  // Order matters for hooks but not for dataflow: useAgentTurn owns the
  // streaming flag; useAgentThreads consumes it (pauses detail polling
  // while a turn is in flight) and exposes the ids the turn hook needs —
  // the turn's send takes the thread id per call, so there is no cycle.
  const {
    streaming,
    streams,
    pendingUserMessage,
    pendingMessageId,
    turnThreadId,
    send,
    stop,
  } = useAgentTurn()
  const {
    threadsQuery,
    detailQuery,
    threads,
    activeThreadId,
    activeThread,
    setActiveThreadId,
    createThread: createThreadAndSelect,
    refresh,
  } = useAgentThreads(streaming)

  const detail = detailQuery.data
  // The threads-list role decides the invited-preview branch in the
  // message list — the detail query's role is unavailable when its fetch
  // 404s (invited preview) or fails/hits a cache miss (owner, member).
  const activeRole = activeThread?.role
  const messages = detail?.messages ?? EMPTY_MESSAGES
  const members: Member[] = detail?.members ?? EMPTY_MEMBERS

  // Name resolution for user messages in (potentially shared) threads.
  // Departed members keep their attribution: leaving deletes the roster
  // row but not the user row, so the directory (/api/users — the same
  // key/cache the invite dialog uses) fills the gap. The directory omits
  // the requesting user, which is fine: viewers are always owner or
  // member, so their own name resolves from the roster. Fetched only
  // when some message references an author the roster no longer lists.
  const hasDepartedAuthors = useMemo(() => {
    const ids = new Set(members.map((m) => m.userId))
    return messages.some((m) => m.userId !== null && !ids.has(m.userId))
  }, [members, messages])
  const usersQuery = useQuery<{ users: UserRow[] }>({
    queryKey: USERS_KEY,
    enabled: hasDepartedAuthors,
    queryFn: fetchUsers,
  })
  const namesById = useMemo(() => {
    const m = new Map<number, string>()
    for (const mem of members) m.set(mem.userId, mem.name)
    for (const u of usersQuery.data?.users ?? []) {
      if (!m.has(u.id)) m.set(u.id, u.name)
    }
    return m
  }, [members, usersQuery.data])

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
      if (!threadId) {
        // thread creation failed: keep the typed message for a retry
        setInput(content)
        return
      }
    }
    // A pre-persist rejection (HTTP error / unreachable service) never
    // persisted the message — put it back instead of swallowing it.
    if (!(await send(threadId, content))) setInput(content)
  }, [activeThreadId, createThreadAndSelect, input, send, streaming])

  const onRename = useCallback(
    async (threadId: string | undefined, title: string) => {
      if (!threadId) return
      // 400 means the server rejected the title itself; anything else
      // (404 after a concurrent delete, a network failure — which
      // rejects fetch and lands in the catch) is not a length problem,
      // so the generic toast must not claim it was.
      let status: number
      try {
        status = await renameThread(threadId, title)
      } catch {
        status = 0
      }
      if (status !== 200) {
        toast.error(
          status === 400
            ? "Umbenennen fehlgeschlagen (1–80 Zeichen)."
            : "Umbenennen fehlgeschlagen."
        )
        return
      }
      setRenamingThreadId(null)
      refresh()
    },
    [refresh]
  )

  const onInvite = useCallback(
    async (userIds: number[]): Promise<boolean> => {
      if (!activeThreadId) return false
      const count = await invite(activeThreadId, userIds)
      if (count === null) {
        toast.error("Einladung fehlgeschlagen.")
        return false
      }
      toast.success(
        count === 1 ? "1 Einladung gesendet." : `${count} Einladungen gesendet.`
      )
      setInviteOpen(false)
      refresh(activeThreadId)
      return true
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
      if (!ok) {
        toast.error("Ablehnen fehlgeschlagen.")
      }
      // Refresh even on failure: a 404 means the invite was already gone
      // (concurrent decline), and the list should drop the stale row.
      refresh()
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
        role={
          activeRole === "owner" || activeRole === "member"
            ? activeRole
            : undefined
        }
        renaming={renamingThreadId !== null}
        renamingThreadId={renamingThreadId ?? undefined}
        onSelect={setActiveThreadId}
        onCreate={createThreadAndSelect}
        onRename={onRename}
        onStartRename={() => {
          if (activeThreadId) setRenamingThreadId(activeThreadId)
        }}
        onCancelRename={() => setRenamingThreadId(null)}
        onInviteOpen={() => setInviteOpen(true)}
        onDelete={onDelete}
        onLeave={onLeave}
        onJoin={onJoin}
        onDecline={onDecline}
      />
      <MessageListView
        data={detailQuery.data}
        hasError={Boolean(detailQuery.error)}
        threadsError={Boolean(threadsQuery.error)}
        activeThreadId={activeThreadId}
        activeRole={activeRole}
        streaming={streaming}
        streams={streams}
        pendingUserMessage={pendingUserMessage}
        pendingMessageId={pendingMessageId}
        turnThreadId={turnThreadId}
        namesById={namesById}
        invitedTitle={activeThread?.title}
        onJoin={onJoin}
        onDecline={onDecline}
        onRetry={() => {
          if (threadsQuery.error) void threadsQuery.refetch()
          if (detailQuery.error) void detailQuery.refetch()
        }}
        pinTarget={
          streaming && turnThreadId === activeThreadId
            ? "stream"
            : String(messages.length)
        }
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
        members={members}
        onInvite={onInvite}
        onClose={() => setInviteOpen(false)}
      />
    </div>
  )
}
