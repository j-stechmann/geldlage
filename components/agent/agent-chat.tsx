"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ChevronDown,
  ChevronRight,
  LogOut,
  Pencil,
  Plus,
  SendHorizontal,
  Square,
  Trash2,
  UserPlus,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiFetch } from "@/lib/api-fetch"

/**
 * LLM agent chat UI (ADR-0033): threads (own/joined/invited), streamed
 * turns over SSE (delta/reasoning/tool_call/tool_result/done/error),
 * collapsible thinking traces and tool chips. Server contract:
 * app/api/agent/** — frames are `event: <name>\ndata: <json>\n\n`.
 */

interface ThreadSummary {
  id: string
  title: string
  ownerId: number
  role: "owner" | "member" | "invited"
  updatedAt: string
}

interface StoredMessage {
  id: string
  userId: number | null
  role: "user" | "assistant" | "tool"
  content: string
  reasoning: string | null
  toolName: string | null
  toolArgs: string | null
  createdAt: string
  threadSeq: number
}

interface Member {
  userId: number
  name: string
  email: string
  state: string
}

interface ThreadDetail {
  thread: { id: string; title: string; ownerId: number; ownerName: string }
  role: "owner" | "member"
  members: Member[]
  messages: StoredMessage[]
}

interface ToolEvent {
  kind: "tool_call" | "tool_result"
  name: string
  payload: string
}

interface UserRow {
  id: number
  name: string
  email: string
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** Stable empty-array identities keep the derived memos dependency-safe. */
const EMPTY_MESSAGES: StoredMessage[] = []
const EMPTY_MEMBERS: Member[] = []

export function AgentChat() {
  // "stored" = what the user last selected; the effective id derives from
  // it plus the threads list (a vanished thread ⇒ newest own thread).
  const [storedThreadId, setActiveThreadId] = useState<string>(() => {
    if (typeof window === "undefined") return ""
    return window.localStorage.getItem("geldlage.agent.thread") ?? ""
  })
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [streamContent, setStreamContent] = useState("")
  const [streamReasoning, setStreamReasoning] = useState("")
  const [streamTools, setStreamTools] = useState<ToolEvent[]>([])
  const [renaming, setRenaming] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  // The user message of the in-flight turn: rendered optimistically while
  // streaming (polling is paused during the turn, so the DB row the server
  // persisted is not visible to the UI until the post-done refetch).
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(
    null
  )
  const abortRef = useRef<AbortController | null>(null)
  const queryClient = useQueryClient()

  const threadsQuery = useQuery<{ threads: ThreadSummary[] }>({
    queryKey: ["agent-threads"],
    queryFn: async () => readJson(await apiFetch("/api/agent/threads")),
    refetchInterval: 15_000,
  })

  // The derived effective id: a stored id whose thread vanished (owner
  // deleted / membership revoked) yields "" — the view resets and the next
  // send lazily creates a fresh thread.
  const storedThreads = useMemo(
    () => threadsQuery.data?.threads ?? [],
    [threadsQuery.data]
  )
  const storedThreadExists = storedThreads.some((t) => t.id === storedThreadId)
  const newestOwnId = useMemo(() => {
    for (const t of storedThreads) if (t.role === "owner") return t.id
    return ""
  }, [storedThreads])
  const activeThreadId =
    storedThreadId === "" || storedThreadExists
      ? storedThreadId || newestOwnId
      : ""

  const detailQuery = useQuery<ThreadDetail>({
    queryKey: ["agent-messages", activeThreadId],
    enabled: Boolean(activeThreadId) && Boolean(threadsQuery.data),
    queryFn: async () =>
      readJson(await apiFetch(`/api/agent/threads/${activeThreadId}/messages`)),
    refetchInterval: streaming ? false : 4_000,
    retry: false,
  })

  const detail = detailQuery.data
  const role = detail?.role
  const messages = detail?.messages ?? EMPTY_MESSAGES
  const members = detail?.members ?? EMPTY_MEMBERS

  // Name resolution for user messages in (potentially shared) threads.
  const namesById = useMemo(() => {
    const m = new Map<number, string>()
    for (const mem of members) m.set(mem.userId, mem.name)
    return m
  }, [members])

  const activeThread = threadsQuery.data?.threads.find(
    (t) => t.id === activeThreadId
  )

  useEffect(() => {
    if (threadsQuery.data) {
      window.localStorage.setItem("geldlage.agent.thread", activeThreadId)
    }
  }, [activeThreadId, threadsQuery.data])

  const createThread = useCallback(async (): Promise<string | null> => {
    const res = await apiFetch("/api/agent/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      toast.error("Neuer Chat konnte nicht erstellt werden.")
      return null
    }
    const { thread } = await readJson<{ thread: ThreadSummary }>(res)
    await queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
    setActiveThreadId(thread.id)
    return thread.id
  }, [queryClient])

  const send = useCallback(async () => {
    const content = input.trim()
    if (!content || streaming) return
    setInput("")
    let threadId = activeThreadId
    if (!threadId) {
      threadId = (await createThread()) ?? ""
      if (!threadId) return
    }

    // Optimistic user turn: rendered below the stored list while streaming,
    // replaced by the authoritative refetch after done.
    setPendingUserMessage(content)
    setStreaming(true)
    setStreamContent("")
    setStreamReasoning("")
    setStreamTools([])
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await apiFetch(`/api/agent/threads/${threadId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as {
          message?: string
        } | null
        toast.error(body?.message ?? "Der Chat-Dienst ist nicht erreichbar.")
        setStreaming(false)
        return
      }
      await consumeTurn(res.body, {
        onReasoning: (text) => setStreamReasoning((r) => r + text),
        onDelta: (text) => setStreamContent((c) => c + text),
        onTool: (ev) => setStreamTools((tools) => [...tools, ev]),
        onDone: () => undefined,
        onError: (message) => toast.error(message),
      })
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        toast.error("Die Verbindung zum LLM wurde unterbrochen.")
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
      setPendingUserMessage(null)
      await queryClient.invalidateQueries({
        queryKey: ["agent-messages", threadId],
      })
      queryClient
        .invalidateQueries({ queryKey: ["agent-threads"] })
        .catch(() => undefined)
    }
  }, [activeThreadId, createThread, input, queryClient, streaming])

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const onInvite = useCallback(
    async (userIds: number[]) => {
      if (!activeThreadId) return
      const res = await apiFetch(
        `/api/agent/threads/${activeThreadId}/invites`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userIds }),
        }
      )
      if (!res.ok) {
        toast.error("Einladung fehlgeschlagen.")
        return
      }
      const { invited } = await readJson<{ invited: number }>(res)
      toast.success(
        invited === 1
          ? "1 Einladung gesendet."
          : `${invited} Einladungen gesendet.`
      )
      setInviteOpen(false)
      await queryClient.invalidateQueries({
        queryKey: ["agent-messages", activeThreadId],
      })
    },
    [activeThreadId, queryClient]
  )

  const onRename = useCallback(
    async (title: string) => {
      if (!activeThreadId) return
      const res = await apiFetch(`/api/agent/threads/${activeThreadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) {
        toast.error("Umbenennen fehlgeschlagen (1–80 Zeichen).")
        return
      }
      setRenaming(false)
      await queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
    },
    [activeThreadId, queryClient]
  )

  const onDelete = useCallback(async () => {
    if (!activeThreadId) return
    const res = await apiFetch(`/api/agent/threads/${activeThreadId}`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "same-origin" },
    })
    if (!res.ok) {
      toast.error("Löschen fehlgeschlagen.")
      return
    }
    setActiveThreadId("")
    await queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
    toast.success("Chat gelöscht.")
  }, [activeThreadId, queryClient])

  const onLeave = useCallback(async () => {
    if (!activeThreadId) return
    const res = await apiFetch(`/api/agent/threads/${activeThreadId}`, {
      method: "DELETE",
      headers: { "sec-fetch-site": "same-origin" },
    })
    if (!res.ok) {
      toast.error("Verlassen fehlgeschlagen.")
      return
    }
    setActiveThreadId("")
    await queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
  }, [activeThreadId, queryClient])

  const onJoin = useCallback(
    async (threadId: string) => {
      const res = await apiFetch(`/api/agent/threads/${threadId}/join`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      })
      if (!res.ok) {
        toast.error("Beitreten fehlgeschlagen — Einladung wurde entfernt.")
        await queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
        return
      }
      toast.success("Beigetreten.")
      setActiveThreadId(threadId)
      await queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
    },
    [queryClient]
  )

  const onDecline = useCallback(
    async (threadId: string) => {
      const res = await apiFetch(`/api/agent/threads/${threadId}`, {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-origin" },
      })
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ["agent-threads"] })
      }
    },
    [queryClient]
  )

  const threads = threadsQuery.data?.threads ?? []
  const mine = threads.filter((t) => t.role === "owner")
  const joined = threads.filter((t) => t.role === "member")
  const invited = threads.filter((t) => t.role === "invited")

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
        onCreate={createThread}
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
        invitedTitle={activeThread?.title}
        streaming={streaming}
        streamContent={streamContent}
        streamReasoning={streamReasoning}
        streamTools={streamTools}
        pendingUserMessage={pendingUserMessage}
        namesById={namesById}
        onJoin={onJoin}
        onDecline={onDecline}
        pinTarget={streaming ? "stream" : String(messages.length)}
      />
      <ChatInput
        disabled={
          streaming || Boolean(activeThread && activeThread.role === "invited")
        }
        onSend={send}
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

/** Parses the server's SSE frames: `event: <n>\ndata: <json>\n\n`. */
async function consumeTurn(
  body: ReadableStream<Uint8Array>,
  handlers: {
    onReasoning: (text: string) => void
    onDelta: (text: string) => void
    onTool: (ev: ToolEvent) => void
    onDone: () => void
    onError: (message: string) => void
  }
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Frame splitting on the separator pair, CRLF-tolerant (the route's
    // frames are LF, but intermediaries may reframe).
    let sep: number
    while ((sep = buffer.search(/\n\n|\r\n\r\n/)) !== -1) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + (buffer.startsWith("\r\n\r\n", sep) ? 4 : 2))
      // The event NAME decides routing — never substring-match the whole
      // frame: a delta's payload can legitimately contain "event: done"
      // and would otherwise be misrouted.
      const eventLine = raw.split(/\r?\n/).find((l) => l.startsWith("event:"))
      const event = eventLine?.slice(6).trim()
      const dataLine = raw.split(/\r?\n/).find((l) => l.startsWith("data:"))
      if (!event || !dataLine) continue
      try {
        const payload = JSON.parse(dataLine.slice(5).trim()) as {
          text?: string
          name?: string
          args?: string
          result?: string
          message?: string
        }
        if (event === "reasoning") handlers.onReasoning(payload.text ?? "")
        else if (event === "delta") handlers.onDelta(payload.text ?? "")
        else if (event === "tool_call")
          handlers.onTool({
            kind: "tool_call",
            name: payload.name ?? "",
            payload: payload.args ?? "",
          })
        else if (event === "tool_result")
          handlers.onTool({
            kind: "tool_result",
            name: payload.name ?? "",
            payload: payload.result ?? "",
          })
        else if (event === "done") handlers.onDone()
        else if (event === "error")
          handlers.onError(payload.message ?? "Unbekannter Fehler.")
      } catch {
        // malformed frame — skip
      }
    }
  }
}

interface ThreadBarProps {
  activeThread: ThreadSummary | undefined
  mine: ThreadSummary[]
  joined: ThreadSummary[]
  invited: ThreadSummary[]
  role: "owner" | "member" | undefined
  renaming: boolean
  onSelect: (id: string) => void
  onCreate: () => Promise<string | null>
  onRename: (title: string) => Promise<void>
  onStartRename: () => void
  onInviteOpen: () => void
  onDelete: () => Promise<void>
  onLeave: () => Promise<void>
  onJoin: (id: string) => Promise<void>
  onDecline: (id: string) => Promise<void>
}

function ThreadBar(props: ThreadBarProps) {
  const [draft, setDraft] = useState("")

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Neuer Chat"
        title="Neuer Chat"
        onClick={() => props.onCreate()}
      >
        <Plus className="size-4" />
      </Button>
      {props.renaming ? (
        <form
          className="flex flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            props.onRename(draft)
          }}
        >
          <Input
            autoFocus
            value={draft}
            maxLength={80}
            placeholder="Titel…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => props.onStartRename()}
            className="h-7"
          />
        </form>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm">
          {props.activeThread?.title ?? "Kein Chat ausgewählt"}
        </span>
      )}
      {props.role === "owner" && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Chat umbenennen"
            title="Umbenennen"
            onClick={() => {
              setDraft(props.activeThread?.title ?? "")
              props.onStartRename()
            }}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Andere einladen"
            title="Einladen"
            onClick={props.onInviteOpen}
          >
            <UserPlus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Chat löschen"
            title="Löschen"
            onClick={() => {
              if (window.confirm("Diesen Chat wirklich löschen?"))
                props.onDelete()
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      )}
      {props.role === "member" && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Chat verlassen"
          title="Verlassen"
          onClick={props.onLeave}
        >
          <LogOut className="size-4" />
        </Button>
      )}
      <ThreadSelect
        mine={props.mine}
        joined={props.joined}
        invited={props.invited}
        activeThread={props.activeThread}
        onSelect={props.onSelect}
        onJoin={props.onJoin}
        onDecline={props.onDecline}
      />
    </div>
  )
}

function ThreadSelect(props: {
  mine: ThreadSummary[]
  joined: ThreadSummary[]
  invited: ThreadSummary[]
  activeThread: ThreadSummary | undefined
  onSelect: (id: string) => void
  onJoin: (id: string) => Promise<void>
  onDecline: (id: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const total = props.mine.length + props.joined.length + props.invited.length
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {total > 0 ? `${total} Chats` : "Chats"}
        <ChevronDown className="size-3.5" />
      </Button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute top-8 right-0 z-50 w-64 rounded-lg border bg-popover p-1 shadow-md">
            {total === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Noch keine Chats.
              </p>
            )}
            <ThreadGroup
              label="Meine Chats"
              threads={props.mine}
              activeThread={props.activeThread}
              onSelect={(id) => {
                setOpen(false)
                props.onSelect(id)
              }}
            />
            <ThreadGroup
              label="Geteilte Chats"
              threads={props.joined}
              activeThread={props.activeThread}
              onSelect={(id) => {
                setOpen(false)
                props.onSelect(id)
              }}
            />
            {props.invited.length > 0 && (
              <ThreadGroup
                label="Einladungen"
                threads={props.invited}
                activeThread={props.activeThread}
                onSelect={(id) => {
                  // invited: select shows the join panel — handled by the
                  // message list; selecting does not join implicitly.
                  setOpen(false)
                  props.onSelect(id)
                }}
                actions={(t) => (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onJoin(t.id)
                      }}
                    >
                      Annehmen
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onDecline(t.id)
                      }}
                    >
                      Ablehnen
                    </Button>
                  </>
                )}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

function ThreadGroup(props: {
  label: string
  threads: ThreadSummary[]
  activeThread: ThreadSummary | undefined
  onSelect: (id: string) => void
  actions?: (t: ThreadSummary) => React.ReactNode
}) {
  if (props.threads.length === 0) return null
  return (
    <div className="py-0.5">
      <p className="px-2 py-0.5 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
        {props.label}
      </p>
      {props.threads.map((t) => (
        <button
          key={t.id}
          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
          onClick={() => props.onSelect(t.id)}
        >
          <span className="min-w-0 truncate">{t.title}</span>
          {props.actions?.(t)}
        </button>
      ))}
    </div>
  )
}

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

function MessageListView(props: MessageListProps) {
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

  const data = props.data
  const multiAuthor =
    new Set(data.messages.filter((m) => m.userId !== null).map((m) => m.userId))
      .size > 1

  return (
    <div ref={setListEl} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="flex flex-col gap-2.5">
        {data.messages.map((m) => (
          <MessageRow
            key={m.id}
            message={m}
            namesById={props.namesById}
            showAuthor={multiAuthor}
          />
        ))}
        {props.pendingUserMessage && (
          <div className="flex justify-end">
            <div className="max-w-[85%]">
              <div className="rounded-xl rounded-br-sm bg-primary px-3 py-1.5 text-sm whitespace-pre-wrap text-primary-foreground">
                {props.pendingUserMessage}
              </div>
            </div>
          </div>
        )}
        {props.streaming && (
          <StreamingBubble
            content={props.streamContent}
            reasoning={props.streamReasoning}
            tools={props.streamTools}
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
          <div className="rounded-xl rounded-br-sm bg-primary px-3 py-1.5 text-sm whitespace-pre-wrap text-primary-foreground">
            {m.content}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <AssistantBody content={m.content} reasoning={m.reasoning} />
      </div>
    </div>
  )
}

function AssistantBody(props: { content: string; reasoning: string | null }) {
  const [showThinking, setShowThinking] = useState(false)
  return (
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
      <p className="whitespace-pre-wrap">{props.content}</p>
    </div>
  )
}

function StreamingBubble(props: {
  content: string
  reasoning: string
  tools: ToolEvent[]
}) {
  const [showThinking, setShowThinking] = useState(true)
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
          {props.tools.map((t, i) => (
            <ToolChip
              key={i}
              name={t.name}
              args={t.kind === "tool_call" ? t.payload : ""}
              result={t.kind === "tool_result" ? t.payload : ""}
            />
          ))}
          <p className="whitespace-pre-wrap">
            {props.content}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/70 align-middle" />
          </p>
        </div>
      </div>
    </div>
  )
}

function ToolChip(props: { name: string; args: string; result: string }) {
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

function ChatInput(props: {
  disabled: boolean
  streaming: boolean
  input: string
  setInput: (v: string) => void
  onSend: () => void
  onStop: () => void
}) {
  return (
    <form
      className="flex items-center gap-1.5 border-t p-2"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSend()
      }}
    >
      <Input
        autoFocus
        value={props.input}
        placeholder="Nachricht…"
        disabled={props.disabled}
        onChange={(e) => props.setInput(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !(
              e.nativeEvent instanceof KeyboardEvent &&
              e.nativeEvent.isComposing
            )
          ) {
            e.preventDefault()
            props.onSend()
          }
        }}
        className="h-8"
      />
      {props.streaming ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Stoppen"
          onClick={props.onStop}
        >
          <Square className="size-4" />
        </Button>
      ) : (
        <Button
          type="submit"
          size="icon"
          aria-label="Senden"
          disabled={props.disabled || !props.input.trim()}
        >
          <SendHorizontal className="size-4" />
        </Button>
      )}
    </form>
  )
}

function InviteDialog(props: {
  open: boolean
  threadId: string
  members: Member[]
  onInvite: (userIds: number[]) => Promise<void>
  onClose: () => void
}) {
  const [selected, setSelected] = useState<number[]>([])
  const usersQuery = useQuery<{ users: UserRow[] }>({
    queryKey: ["agent-users"],
    enabled: props.open,
    queryFn: async () => readJson(await apiFetch("/api/users")),
  })
  const memberIds = new Set(props.members.map((m) => m.userId))
  const candidates = (usersQuery.data?.users ?? []).filter(
    (u) => !memberIds.has(u.id)
  )

  const toggle = (id: number) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id]
    )

  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => (o ? undefined : props.onClose())}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chateinladung</DialogTitle>
        </DialogHeader>
        <div className="max-h-64 overflow-y-auto">
          {candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">Niemand zu laden.</p>
          )}
          {candidates.map((u) => (
            <label
              key={u.id}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={selected.includes(u.id)}
                onChange={() => toggle(u.id)}
                className="size-3.5 accent-primary"
              />
              <span className="truncate">{u.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {u.email}
              </span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Abbrechen
          </Button>
          <Button
            size="sm"
            disabled={selected.length === 0}
            onClick={() => props.onInvite(selected).then(() => setSelected([]))}
          >
            Einladen
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
