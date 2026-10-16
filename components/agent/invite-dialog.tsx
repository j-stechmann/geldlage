"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ErrorState } from "@/components/error-state"
import {
  MEMBERS_KEY,
  USERS_KEY,
  fetchMembers,
  fetchUsers,
} from "@/components/agent/agent-api"
import type { Member, UserRow } from "@/components/agent/types"

/**
 * Member-management dialog (ADR-0033): the roster from the owner-only
 * GET /invites route (fetched only while open) with per-row retract
 * (invited) / remove (joined), plus the invite section — the user
 * directory minus the roster, checkbox multi-select. One dialog for
 * the whole share lifecycle; non-owner rows are never offered.
 */

/** Section labels, styled like the thread dropdown's group labels. */
const LIST_LABEL =
  "px-2 py-0.5 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase"

const STATE_LABELS: Record<string, string> = {
  owner: "Besitzer",
  joined: "Mitglied",
  invited: "Eingeladen",
}

interface InviteDialogProps {
  open: boolean
  threadId: string
  /** Resolves to true when the invite succeeded (selection may clear). */
  onInvite: (userIds: number[]) => Promise<boolean>
  /** Resolves to true when the retract/removal succeeded (roster refetches). */
  onRemove: (member: Member) => Promise<boolean>
  onClose: () => void
}

export function InviteDialog(props: InviteDialogProps) {
  const [selected, setSelected] = useState<number[]>([])
  // Members whose removal is in flight — a Set, not a single id: with
  // two removals running, the earlier one's cleanup must not re-enable
  // the other's button (a second DELETE would only race the first: the
  // loser gets {removed: false, state: null} and a duplicate toast).
  const [removingIds, setRemovingIds] = useState<Set<number>>(() => new Set())
  const usersQuery = useQuery<{ users: UserRow[] }>({
    queryKey: USERS_KEY,
    enabled: props.open,
    queryFn: fetchUsers,
  })
  const rosterQuery = useQuery<{ members: Member[] }>({
    queryKey: MEMBERS_KEY(props.threadId),
    enabled: props.open && props.threadId !== "",
    queryFn: () => fetchMembers(props.threadId),
  })
  const roster = rosterQuery.data?.members
  // Candidates need both sources: rendering the directory before the
  // roster lands would offer existing members as invitable (the POST is
  // idempotent, but the list would still mislead).
  const candidates =
    roster === undefined
      ? []
      : (usersQuery.data?.users ?? []).filter(
          (u) => !roster.some((m) => m.userId === u.id)
        )

  const toggle = (id: number) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id]
    )

  const removeFromRoster = (member: Member) => {
    setRemovingIds((s) => new Set(s).add(member.userId))
    // .catch keeps a thrown network error from becoming an unhandled
    // rejection (the handler already toasts it; the button re-enables
    // for retry). The finally drops exactly this member's id — a
    // concurrent removal on another row keeps its own disable.
    void props
      .onRemove(member)
      .catch(() => {})
      .finally(() =>
        setRemovingIds((s) => {
          const next = new Set(s)
          next.delete(member.userId)
          return next
        })
      )
  }

  // Closing (cancel, backdrop, ESC) drops the selection and any
  // in-flight disables; a failed invite keeps the selection so the user
  // can retry without re-checking rows.
  const closeAndReset = () => {
    setSelected([])
    setRemovingIds(new Set())
    props.onClose()
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => (o ? undefined : closeAndReset())}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mitglieder &amp; Einladungen</DialogTitle>
        </DialogHeader>
        <section>
          <p className={LIST_LABEL}>Mitglieder</p>
          <div className="max-h-64 overflow-y-auto">
            {rosterQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : rosterQuery.isError && !rosterQuery.data ? (
              <ErrorState onRetry={() => void rosterQuery.refetch()} />
            ) : (
              (roster ?? []).map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
                >
                  <span className="truncate">{m.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {m.email}
                  </span>
                  <Badge
                    variant={m.state === "invited" ? "outline" : "secondary"}
                    className="ml-auto shrink-0"
                  >
                    {STATE_LABELS[m.state] ?? m.state}
                  </Badge>
                  {/* The owner row is never removable (the route enforces
                      it too — 400 cannot_remove_owner). */}
                  {m.state !== "owner" && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={removingIds.has(m.userId)}
                      aria-label={
                        m.state === "invited"
                          ? "Einladung zurückziehen"
                          : "Mitglied entfernen"
                      }
                      title={
                        m.state === "invited" ? "Zurückziehen" : "Entfernen"
                      }
                      onClick={() => removeFromRoster(m)}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
        <section>
          <p className={LIST_LABEL}>Weitere einladen</p>
          <div className="max-h-64 overflow-y-auto">
            {usersQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : usersQuery.isError && !usersQuery.data ? (
              <ErrorState onRetry={() => void usersQuery.refetch()} />
            ) : roster === undefined ? (
              <p className="text-sm text-muted-foreground">…</p>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">Niemand zu laden.</p>
            ) : (
              candidates.map((u) => (
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
              ))
            )}
          </div>
        </section>
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
