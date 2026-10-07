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
  onInvite: (userIds: number[]) => Promise<void>
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

export type { Member }
export type InviteResult = Awaited<ReturnType<typeof invite>>
