"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { resolveCategoryColor } from "@/lib/category-colors"
import { apiFetch } from "@/lib/api-fetch"

interface LabelRow {
  id: number
  name: string
  origin: string
  usageCount: number
  color: string | null
  ruleCount: number
}

interface LabelRuleRow {
  id: number
  labelId: number
  payer: string
  payee: string
  counterpartyIban: string
  createdAt: string
}

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["labels"] })
  void queryClient.invalidateQueries({ queryKey: ["label-rules"] })
  void queryClient.invalidateQueries({ queryKey: ["transactions"] })
  void queryClient.invalidateQueries({ queryKey: ["analytics"] })
  void queryClient.invalidateQueries({ queryKey: ["categories"] })
  void queryClient.invalidateQueries({ queryKey: ["prediction"] })
}

function OriginBadge({ origin }: { origin: string }) {
  if (origin === "manual") {
    return (
      <Badge variant="secondary" className="font-normal">
        manuell
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      erfunden
    </Badge>
  )
}

function CreateLabelForm() {
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const res = await apiFetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = (await res.json()) as { error?: string; message?: string }
      if (res.status === 201) {
        toast.success(`Label "${name.trim()}" erstellt`)
        setName("")
        invalidateAll(queryClient)
      } else if (res.status === 409) {
        toast.error("Label existiert bereits")
      } else {
        toast.error("Erstellen fehlgeschlagen", {
          description: data.message ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toast.error("Erstellen fehlgeschlagen", {
        description: err instanceof Error ? err.message : "Netzwerkfehler",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex gap-2">
      <Input
        placeholder="Neues Label…"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create()
        }}
      />
      <Button disabled={busy || !name.trim()} onClick={() => void create()}>
        <Plus className="size-4" /> Hinzufügen
      </Button>
    </div>
  )
}

function RenameDialog({
  label,
  onClose,
}: {
  label: LabelRow
  onClose: () => void
}) {
  const [name, setName] = React.useState(label.name)
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const rename = async () => {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/labels/${label.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = (await res.json()) as { error?: string; message?: string }
      if (res.ok) {
        toast.success("Label umbenannt", { description: name.trim() })
        invalidateAll(queryClient)
        onClose()
      } else if (res.status === 409) {
        toast.error("Name bereits vergeben")
      } else {
        toast.error("Umbenennen fehlgeschlagen", {
          description: data.message ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toast.error("Umbenennen fehlgeschlagen", {
        description: err instanceof Error ? err.message : "Netzwerkfehler",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Label umbenennen</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          maxLength={64}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void rename()
          }}
        />
        <p className="text-xs text-muted-foreground">
          Umbenannte Labels gelten als bestätigt und werden nicht mehr als
          &quot;erfunden&quot; markiert.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void rename()}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteLabelDialog({
  label,
  onClose,
}: {
  label: LabelRow
  onClose: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const remove = async () => {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/labels/${label.id}`, {
        method: "DELETE",
      })
      const data = (await res.json()) as {
        affected?: number
        error?: string
      }
      if (res.ok) {
        toast.success(`Label "${label.name}" gelöscht`, {
          description:
            data.affected === 1
              ? "Eine Transaktion wird neu kategorisiert."
              : `${data.affected ?? 0} Transaktionen werden neu kategorisiert.`,
        })
        invalidateAll(queryClient)
        onClose()
      } else {
        toast.error("Löschen fehlgeschlagen", {
          description: data.error ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toast.error("Löschen fehlgeschlagen", {
        description: err instanceof Error ? err.message : "Netzwerkfehler",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Label löschen?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Das Label &quot;{label.name}&quot; wird entfernt ({label.ruleCount}{" "}
          gelernte {label.ruleCount === 1 ? "Regel" : "Regeln"} inklusive). Alle
          Transaktionen mit diesem Label verlieren ihre Kategorie und werden vom
          LLM neu kategorisiert.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" /> Löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditRuleDialog({
  rule,
  labels,
  onClose,
}: {
  rule: LabelRuleRow
  labels: LabelRow[]
  onClose: () => void
}) {
  const [labelId, setLabelId] = React.useState(String(rule.labelId))
  const [payer, setPayer] = React.useState(rule.payer)
  const [payee, setPayee] = React.useState(rule.payee)
  const [iban, setIban] = React.useState(rule.counterpartyIban)
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const save = async () => {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/label-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          labelId: Number.parseInt(labelId, 10),
          payer: payer.trim(),
          payee: payee.trim(),
          counterpartyIban: iban.trim(),
        }),
      })
      const data = (await res.json()) as { error?: string; message?: string }
      if (res.ok) {
        toast.success("Regel aktualisiert")
        invalidateAll(queryClient)
        onClose()
      } else if (res.status === 409) {
        toast.error("Regel existiert bereits")
      } else {
        toast.error("Bearbeiten fehlgeschlagen", {
          description: data.message ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toast.error("Bearbeiten fehlgeschlagen", {
        description: err instanceof Error ? err.message : "Netzwerkfehler",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Regel bearbeiten</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Label</span>
            <Select
              items={Object.fromEntries(
                labels.map((l) => [String(l.id), l.name])
              )}
              value={labelId}
              onValueChange={(value) => value && setLabelId(value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {labels.map((label) => (
                  <SelectItem key={label.id} value={String(label.id)}>
                    {label.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              Zahlungspflichtige*r
            </span>
            <Input
              value={payer}
              autoFocus
              onChange={(e) => setPayer(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              Zahlungsempfänger*in
            </span>
            <Input value={payee} onChange={(e) => setPayee(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">IBAN</span>
            <Input value={iban} onChange={(e) => setIban(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Änderungen wirken erst, wenn du die Regel mit &quot;Anwenden&quot;
            auf bestehende Transaktionen loslässt.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={busy || !payer.trim() || !payee.trim() || !iban.trim()}
            onClick={() => void save()}
          >
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApplyRuleDialog({
  rule,
  labels,
  onClose,
}: {
  rule: LabelRuleRow
  labels: LabelRow[]
  onClose: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  // Live query instead of a one-shot fetch: invalidateAll refetches it while
  // the dialog is open, so the preview count tracks transaction changes.
  const {
    data,
    isLoading,
    isError: failed,
  } = useQuery<{ count: number }>({
    queryKey: ["label-rules", rule.id, "matches"],
    queryFn: async () => {
      const res = await apiFetch(`/api/label-rules/${rule.id}/matches`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })
  const count = data?.count ?? null

  const apply = async () => {
    setBusy(true)
    try {
      const res = await apiFetch(`/api/label-rules/${rule.id}/apply`, {
        method: "POST",
      })
      const data = (await res.json()) as {
        applied?: number
        error?: string
        message?: string
      }
      if (res.ok) {
        toast.success("Regel angewendet", {
          description:
            data.applied === 1
              ? "Eine Transaktion wird neu gelabelt."
              : `${data.applied ?? 0} Transaktionen werden neu gelabelt.`,
        })
        invalidateAll(queryClient)
        onClose()
      } else {
        toast.error("Anwenden fehlgeschlagen", {
          description: data.message ?? data.error ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toast.error("Anwenden fehlgeschlagen", {
        description: err instanceof Error ? err.message : "Netzwerkfehler",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Regel anwenden?</DialogTitle>
        </DialogHeader>
        {failed ? (
          <p className="text-sm text-destructive">
            Treffer konnten nicht gezählt werden.
          </p>
        ) : isLoading || count === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {count === 1
              ? "Eine Transaktion passt zu dieser Regel. Sie erhält das Label "
              : `${count} Transaktionen passen zu dieser Regel. Sie erhalten das Label `}
            &quot;{labels.find((l) => l.id === rule.labelId)?.name ?? "?"}&quot;
            zugeordnet und {count === 1 ? "wird" : "werden"} vom LLM neu
            kategorisiert – auch bereits manuell zugewiesene.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={busy || failed || count === null || count === 0}
            onClick={() => void apply()}
          >
            <RefreshCw className="size-4" /> Anwenden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RulesList({
  labelId,
  labels,
}: {
  labelId: number
  labels: LabelRow[]
}) {
  const { data } = useQuery<{ rules: LabelRuleRow[] }>({
    queryKey: ["label-rules", labelId],
    queryFn: async () => {
      const res = await apiFetch(`/api/labels/${labelId}/rules`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })
  const [busyId, setBusyId] = React.useState<number | null>(null)
  const [editTargetId, setEditTargetId] = React.useState<number | null>(null)
  const [applyTargetId, setApplyTargetId] = React.useState<number | null>(null)
  const queryClient = useQueryClient()

  const rules = data?.rules ?? []
  if (rules.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Keine gelernten Regeln – Regeln entstehen durch manuelle Zuweisung in
        der Transaktionstabelle.
      </p>
    )
  }

  // Derive dialogs from the live rules list so a deleted rule (or its label)
  // closes the dialog instead of operating on stale state.
  const editTarget = rules.find((r) => r.id === editTargetId) ?? null
  const applyTarget = rules.find((r) => r.id === applyTargetId) ?? null

  return (
    <div className="space-y-1">
      {rules.map((rule) => (
        <div
          key={rule.id}
          className="flex items-center justify-between gap-2 rounded border px-2 py-1"
        >
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">
              {rule.payer} → {rule.payee}
            </p>
            <p
              className="truncate text-xs text-muted-foreground"
              title={rule.counterpartyIban}
            >
              {rule.counterpartyIban}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={busyId === rule.id}
              onClick={() => setEditTargetId(rule.id)}
              title="Regel bearbeiten"
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busyId === rule.id}
              onClick={() => setApplyTargetId(rule.id)}
              title="Auf bestehende Transaktionen anwenden"
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busyId === rule.id}
              onClick={async () => {
                setBusyId(rule.id)
                try {
                  const res = await apiFetch(`/api/label-rules/${rule.id}`, {
                    method: "DELETE",
                  })
                  if (res.ok) {
                    toast.success("Regel gelöscht")
                    invalidateAll(queryClient)
                  } else {
                    toast.error("Löschen der Regel fehlgeschlagen")
                  }
                } catch {
                  toast.error("Löschen der Regel fehlgeschlagen", {
                    description: "Netzwerkfehler",
                  })
                } finally {
                  setBusyId(null)
                }
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
      {editTarget && (
        <EditRuleDialog
          rule={editTarget}
          labels={labels}
          onClose={() => setEditTargetId(null)}
        />
      )}
      {applyTarget && (
        <ApplyRuleDialog
          rule={applyTarget}
          labels={labels}
          onClose={() => setApplyTargetId(null)}
        />
      )}
    </div>
  )
}

export default function LabelsPage() {
  const { data, isLoading } = useQuery<{ labels: LabelRow[] }>({
    queryKey: ["labels"],
    queryFn: async () => {
      const res = await apiFetch("/api/labels")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })

  const [renameTarget, setRenameTarget] = React.useState<LabelRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<LabelRow | null>(null)
  const [expandedId, setExpandedId] = React.useState<number | null>(null)

  const labels = data?.labels ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Labels
        </h1>
        <p className="text-sm text-muted-foreground">
          Kategorien verwalten. Gelernte Regeln entstehen durch manuelle
          Zuweisung in der Transaktionstabelle, können bearbeitet werden und
          schlagen passende Labels dem LLM vor. Mit &quot;Anwenden&quot; wird
          eine Regel auf alle bestehenden passenden Transaktionen losgelassen.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Neues Label</CardTitle>
          <CardDescription>
            Erstellt ein manuelles Label, das das LLM sofort verwenden kann.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateLabelForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Alle Labels {data ? `(${labels.length})` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && labels.length === 0 ? (
            <p className="text-sm text-muted-foreground">…</p>
          ) : labels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Noch keine Labels vorhanden.
            </p>
          ) : (
            labels.map((label) => (
              <div
                key={label.id}
                className="rounded-lg border p-3 transition-colors hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={
                        {
                          "--category-color": resolveCategoryColor(
                            label.id,
                            label.color
                          ),
                        } as React.CSSProperties
                      }
                    />
                    <span className="truncate font-medium">{label.name}</span>
                    <OriginBadge origin={label.origin} />
                    <Badge
                      variant="outline"
                      className="font-normal text-muted-foreground tabular-nums"
                    >
                      {label.usageCount}×
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setExpandedId((id) =>
                          id === label.id ? null : label.id
                        )
                      }
                    >
                      {label.ruleCount}{" "}
                      {label.ruleCount === 1 ? "Regel" : "Regeln"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRenameTarget(label)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(label)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {expandedId === label.id && (
                  <div className="mt-2 border-t pt-2">
                    <RulesList labelId={label.id} labels={labels} />
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {renameTarget && (
        <RenameDialog
          label={renameTarget}
          onClose={() => setRenameTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteLabelDialog
          label={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
