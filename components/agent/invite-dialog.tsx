"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { USERS_KEY, fetchUsers, invite } from "@/components/agent/agent-api"
import type { Member, UserRow } from "@/components/agent/types"

/**
 * Invite dialog (ADR-0033): user directory (fetched only while open,
 * minus existing members) with checkbox multi-select.
 */

interface InviteDialogProps {
  open: boolean
  threadId: string
  members: Member[]
  /** Resolves to true when the invite succeeded (selection may clear). */
  onInvite: (userIds: number[]) => Promise<boolean>
  onClose: () => void
}

export function InviteDialog(props: InviteDialogProps) {
  const [selected, setSelected] = useState<number[]>([])
  const usersQuery = useQuery<{ users: UserRow[] }>({
    queryKey: USERS_KEY,
    enabled: props.open,
    queryFn: fetchUsers,
  })
  const memberIds = new Set(props.members.map((m) => m.userId))
  const candidates = (usersQuery.data?.users ?? []).filter(
    (u) => !memberIds.has(u.id)
  )

  const toggle = (id: number) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id]
    )

  // Closing (cancel, backdrop, ESC) drops the selection; a failed invite
  // keeps it so the user can retry without re-checking rows.
  const closeAndReset = () => {
    setSelected([])
    props.onClose()
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => (o ? undefined : closeAndReset())}
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
          <Button variant="outline" size="sm" onClick={closeAndReset}>
            Abbrechen
          </Button>
          <Button
            size="sm"
            disabled={selected.length === 0}
            // Clear only on success (onInvite resolves false on failure);
            // .catch keeps a thrown network error from becoming an
            // unhandled rejection (selection stays for retry).
            onClick={() =>
              void props
                .onInvite(selected)
                .then((ok) => {
                  if (ok) setSelected([])
                })
                .catch(() => {})
            }
          >
            Einladen
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export type { Member }
export type InviteResult = Awaited<ReturnType<typeof invite>>
