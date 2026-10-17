"use client"

import { useState } from "react"
import {
  ChevronDown,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { THREAD_TITLE_MAX_INPUT_CHARS } from "@/lib/agent/constants"
import type { ThreadSummary } from "@/components/agent/types"

/**
 * Thread bar (ADR-0033): new-chat button, title display / inline rename
 * form, owner actions (rename, invite, delete), member leave, and the
 * grouped thread dropdown (Meine Chats / Geteilte Chats / Einladungen).
 * Selecting an invite shows the join panel — handled by the message list;
 * selecting does not join implicitly.
 */

interface ThreadBarProps {
  activeThread: ThreadSummary | undefined
  mine: ThreadSummary[]
  joined: ThreadSummary[]
  invited: ThreadSummary[]
  role: "owner" | "member" | undefined
  renaming: boolean
  /** The stored id being renamed — rename applies to this, not to whichever
   * thread is active on submit (a select during rename must not retarget). */
  renamingThreadId: string | undefined
  onSelect: (id: string) => void
  onCreate: () => Promise<string | null>
  /** Submits the draft for the thread captured at pencil-click time —
   * NOT `activeThread`, which may have changed mid-rename. */
  onRename: (threadId: string | undefined, title: string) => Promise<void>
  onStartRename: () => void
  /** Leaves rename mode without submitting (blur, Escape, empty draft). */
  onCancelRename: () => void
  onInviteOpen: () => void
  onDelete: () => Promise<void>
  onLeave: () => Promise<void>
  onJoin: (id: string) => Promise<void>
  onDecline: (id: string) => Promise<void>
}

export function ThreadBar(props: ThreadBarProps) {
  const [draft, setDraft] = useState("")

  const startRename = () => {
    setDraft(props.activeThread?.title ?? "")
    props.onStartRename()
  }

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
            const title = draft.trim()
            if (!title) {
              props.onCancelRename()
              return
            }
            void props.onRename(props.renamingThreadId, title)
          }}
        >
          <Input
            autoFocus
            value={draft}
            maxLength={THREAD_TITLE_MAX_INPUT_CHARS}
            placeholder="Titel…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={props.onCancelRename}
            onKeyDown={(e) => {
              if (e.key === "Escape") props.onCancelRename()
            }}
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
            onClick={startRename}
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
                  setOpen(false)
                  props.onSelect(id)
                }}
                actions={(t) => (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => props.onJoin(t.id)}
                    >
                      Annehmen
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => props.onDecline(t.id)}
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
        // Row is a div, not a button: the optional invite actions render
        // real <button>s and buttons must not nest (invalid HTML →
        // hydration warnings). Title button + action buttons as siblings.
        <div
          key={t.id}
          className="flex w-full items-center justify-between gap-2 rounded-md hover:bg-accent"
        >
          <button
            type="button"
            className="min-w-0 flex-1 rounded-md px-2 py-1 text-left text-sm"
            onClick={() => props.onSelect(t.id)}
          >
            <span className="block truncate">{t.title}</span>
          </button>
          {props.actions?.(t)}
        </div>
      ))}
    </div>
  )
}
