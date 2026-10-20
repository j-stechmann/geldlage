"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Upload, FolderOpen, RefreshCw, FileSpreadsheet } from "lucide-react"
import { toast } from "sonner"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { useActiveImport } from "@/components/active-import-provider"
import { cn } from "@/lib/utils"
import { apiFetch } from "@/lib/api-fetch"

interface BatchRow {
  id: string
  fileName: string
  status: string
  error: string | null
  rowsTotal: number
  rowsImported: number
  rowsDuplicate: number
  rowsUpdated: number
  labelsTotal: number
  labelsDone: number
  labelsFailed: number
  createdAt: string
}

const STATUS_LABELS: Record<string, string> = {
  parsing: "Wird gelesen",
  importing: "Wird gespeichert",
  labeling: "Kategorisierung",
  completed: "Abgeschlossen",
  failed: "Fehlgeschlagen",
}

function ImportDropzone() {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = React.useState(false)
  const { startPolling } = useActiveImport()
  const queryClient = useQueryClient()

  const upload = async (file: File) => {
    setIsUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      const res = await apiFetch("/api/imports", { method: "POST", body })
      const data = (await res.json()) as {
        batchId?: string
        error?: string
        message?: string
      }
      if (res.status === 202 && data.batchId) {
        toast.success("Import gestartet", { description: file.name })
        startPolling(data.batchId)
        void queryClient.invalidateQueries({ queryKey: ["imports"] })
      } else if (res.status === 409) {
        toast.error("Es läuft bereits ein Import.")
      } else {
        toast.error("Import fehlgeschlagen", {
          description: data.error ?? data.message ?? `HTTP ${res.status}`,
        })
      }
    } catch (err) {
      toast.error("Import fehlgeschlagen", {
        description: err instanceof Error ? err.message : "Netzwerkfehler",
      })
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Neuer Import</CardTitle>
        <CardDescription>
          CSV-Export hierher ziehen oder auswählen. Die Verarbeitung erfolgt im
          Hintergrund; Duplikate werden automatisch erkannt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
            "hover:border-primary/50 hover:bg-accent/40"
          )}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) void upload(file)
          }}
        >
          <Upload className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            CSV-Datei hier ablegen
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f)
              e.target.value = ""
            }}
          />
          <Button
            disabled={isUploading}
            onClick={() => inputRef.current?.click()}
          >
            <FolderOpen className="size-4" />
            {isUploading ? "Wird hochgeladen…" : "Datei auswählen"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function RetryLabelingButton() {
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const res = await apiFetch("/api/labels/retry", { method: "POST" })
          const data = (await res.json()) as {
            queued?: number
            message?: string
          }
          if (res.status === 202) {
            if ((data.queued ?? 0) > 0) {
              toast.success(
                `Kategorisierung erneut eingeplant: ${data.queued} Transaktionen`,
                { description: "Die Verarbeitung läuft im Hintergrund." }
              )
            } else {
              toast.info("Keine Transaktionen zum erneuten Versuch vorhanden.")
            }
            void queryClient.invalidateQueries({ queryKey: ["imports"] })
            void queryClient.invalidateQueries({ queryKey: ["import"] })
            void queryClient.invalidateQueries({ queryKey: ["transactions"] })
            void queryClient.invalidateQueries({ queryKey: ["analytics"] })
            void queryClient.invalidateQueries({ queryKey: ["categories"] })
          } else {
            toast.error("Erneuter Versuch fehlgeschlagen", {
              description: data.message ?? `HTTP ${res.status}`,
            })
          }
        } catch {
          toast.error("Erneuter Versuch fehlgeschlagen", {
            description: "Netzwerkfehler",
          })
        } finally {
          setBusy(false)
        }
      }}
    >
      <RefreshCw className={cn("size-4", busy && "animate-spin")} />
      Kategorisierung erneut versuchen
    </Button>
  )
}

function ActiveImportCard() {
  const { batch, activeBatchId } = useActiveImport()
  if (!batch || !activeBatchId) return null

  const terminal = batch.status === "completed" || batch.status === "failed"
  const labelProgress =
    batch.labelsTotal > 0
      ? Math.round(
          ((batch.labelsDone + batch.labelsFailed) / batch.labelsTotal) * 100
        )
      : 0
  const rowProgress =
    batch.rowsTotal > 0
      ? Math.round(
          ((batch.rowsImported + batch.rowsDuplicate + batch.rowsUpdated) /
            batch.rowsTotal) *
            100
        )
      : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{batch.fileName}</CardTitle>
          <Badge
            variant={
              batch.status === "failed"
                ? "destructive"
                : terminal
                  ? "secondary"
                  : "default"
            }
          >
            {STATUS_LABELS[batch.status] ?? batch.status}
          </Badge>
        </div>
        <CardDescription>
          {batch.rowsTotal} Zeilen · {batch.rowsImported} neu ·{" "}
          {batch.rowsDuplicate} Duplikate · {batch.rowsUpdated} aktualisiert
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!terminal && (
          <>
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Speichern</span>
                <span>
                  {batch.rowsImported + batch.rowsDuplicate + batch.rowsUpdated}
                  /{batch.rowsTotal}
                </span>
              </div>
              <Progress value={rowProgress} />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Kategorisierung</span>
                <span>
                  {batch.labelsDone}/{batch.labelsTotal}
                </span>
              </div>
              <Progress value={labelProgress} />
            </div>
          </>
        )}
        {batch.status === "failed" && batch.error && (
          <p className="text-sm text-destructive">{batch.error}</p>
        )}
      </CardContent>
    </Card>
  )
}

function HistoryTable() {
  const { data, isLoading } = useQuery<{ batches: BatchRow[] }>({
    queryKey: ["imports"],
    queryFn: async () => {
      const res = await apiFetch("/api/imports/history")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    refetchInterval: 5000,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import-Verlauf</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Lädt…</p>
        ) : (data?.batches.length ?? 0) === 0 ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <FileSpreadsheet className="size-4" /> Noch keine Imports.
          </p>
        ) : (
          <div className="space-y-2">
            {data!.batches.map((b) => (
              <div
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{b.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(b.createdAt).toLocaleString("de-DE")} ·{" "}
                    {b.rowsImported} neu · {b.rowsDuplicate} Duplikate ·{" "}
                    {b.rowsUpdated} aktualisiert
                    {b.labelsFailed > 0
                      ? ` · ${b.labelsFailed} ohne Kategorie`
                      : ""}
                  </p>
                  {b.error && (
                    <p className="mt-1 text-xs text-destructive">{b.error}</p>
                  )}
                </div>
                <Badge
                  variant={
                    b.status === "failed"
                      ? "destructive"
                      : b.status === "completed"
                        ? "secondary"
                        : "default"
                  }
                >
                  {STATUS_LABELS[b.status] ?? b.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function ImportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Imports
        </h1>
        <p className="text-sm text-muted-foreground">
          CSV-Exporte importieren und Verlauf einsehen.
        </p>
      </div>
      {/* @min-[1024px] (container query on <main>) instead of viewport
          lg: this page reflows against the space left of the agent dock,
          like the dashboard grids (see app/page.tsx). */}
      <div className="grid gap-4 @min-[1024px]:grid-cols-2">
        <ImportDropzone />
        <ActiveImportCard />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Konfiguration: LLM-URL (llama-server) und Kategoriensprache werden
          über Umgebungsvariablen gesetzt (LLM_BASE_URL, LLM_LANGUAGE).
        </p>
        <RetryLabelingButton />
      </div>
      <HistoryTable />
    </div>
  )
}
