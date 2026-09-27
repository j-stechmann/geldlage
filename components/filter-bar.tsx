"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, RotateCcw, Tags } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EMPTY_FILTERS, type TableFilters } from "@/lib/filters"
import { resolveCategoryColor } from "@/lib/category-colors"
import { apiFetch } from "@/lib/api-fetch"
import { cn } from "@/lib/utils"

interface CategoryOption {
  id: number
  name: string
  color: string | null
}

interface AccountOption {
  id: number
  name: string
  iban: string
}

function CategoryDot({ id, color }: { id: number; color: string | null }) {
  return (
    <span
      className="inline-block size-2 shrink-0 self-center rounded-full"
      style={{ backgroundColor: resolveCategoryColor(id, color) }}
      aria-hidden
    />
  )
}

export function FilterBar({
  filters,
  onChange,
}: {
  filters: TableFilters
  onChange: (f: TableFilters) => void
}) {
  const [qDraft, setQDraft] = React.useState(filters.q)
  const lastEmitted = React.useRef(filters.q)

  // resync the draft when filters.q changes externally (back/forward,
  // shared links); our own debounced emits are already reflected in the draft
  const lastSyncedQ = React.useRef(filters.q)
  React.useEffect(() => {
    if (filters.q === lastSyncedQ.current) return
    lastSyncedQ.current = filters.q
    if (filters.q !== lastEmitted.current) {
      lastEmitted.current = filters.q
      setQDraft(filters.q)
    }
  }, [filters.q])

  // debounce search input → propagate to parent via timeout callback;
  // emit the trimmed value so the URL round-trip (paramsToFilters trims q)
  // stays stable and echo keys match
  React.useEffect(() => {
    const t = setTimeout(() => {
      const q = qDraft.trim()
      if (q !== lastEmitted.current) {
        lastEmitted.current = q
        onChange({ ...filters, q })
      }
    }, 300)
    return () => clearTimeout(t)
  }, [qDraft, filters, onChange])

  const { data: categories } = useQuery<CategoryOption[]>({
    queryKey: ["categories"],
    queryFn: async () => {
      const res = await apiFetch("/api/categories")
      const data = (await res.json()) as { categories: CategoryOption[] }
      return data.categories
    },
  })

  const { data: accounts } = useQuery<AccountOption[]>({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await apiFetch("/api/accounts")
      const data = (await res.json()) as { accounts: AccountOption[] }
      return data.accounts
    },
  })

  const categoryLabel =
    filters.categoryIds.length === 0
      ? "Alle Kategorien"
      : filters.categoryIds.length === 1
        ? ((categories ?? []).find((c) => c.id === filters.categoryIds[0])
            ?.name ?? "Kategorie")
        : `${filters.categoryIds.length} Kategorien`

  const selectedAccountLabel =
    filters.accountId !== null
      ? ((accounts ?? []).find((a) => a.id === filters.accountId)?.name ??
        "Konto")
      : null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="Suchen (Empfänger, Verwendungszweck)…"
          className="pl-8"
        />
      </div>

      <div className="flex items-center gap-1">
        <Input
          type="date"
          value={filters.dateFrom ?? ""}
          onChange={(e) =>
            onChange({ ...filters, dateFrom: e.target.value || null })
          }
          className="w-36"
          aria-label="Von"
        />
        <span className="text-muted-foreground">–</span>
        <Input
          type="date"
          value={filters.dateTo ?? ""}
          onChange={(e) =>
            onChange({ ...filters, dateTo: e.target.value || null })
          }
          className="w-36"
          aria-label="Bis"
        />
      </div>

      <Select
        items={{ all: "Alle", Eingang: "Eingang", Ausgang: "Ausgang" }}
        value={filters.type}
        onValueChange={(v) =>
          onChange({ ...filters, type: String(v) as TableFilters["type"] })
        }
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Alle</SelectItem>
          <SelectItem value="Eingang">Eingang</SelectItem>
          <SelectItem value="Ausgang">Ausgang</SelectItem>
        </SelectContent>
      </Select>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "max-w-48",
                filters.categoryIds.length > 0 && "font-medium"
              )}
            >
              <Tags className="size-4" />
              {categoryLabel}
            </Button>
          }
        />
        <DropdownMenuContent>
          {(categories ?? []).map((c) => (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={filters.categoryIds.includes(c.id)}
              onCheckedChange={(checked) => {
                const next = checked
                  ? [...filters.categoryIds, c.id]
                  : filters.categoryIds.filter((id) => id !== c.id)
                onChange({ ...filters, categoryIds: next })
              }}
            >
              <CategoryDot id={c.id} color={c.color} />
              {c.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Select
        items={(accounts ?? []).reduce<Record<string, React.ReactNode>>(
          (acc, a) => {
            acc[String(a.id)] = a.name
            return acc
          },
          { all: "Alle Konten" }
        )}
        value={filters.accountId !== null ? String(filters.accountId) : "all"}
        onValueChange={(v) =>
          onChange({
            ...filters,
            accountId: v === "all" ? null : Number.parseInt(String(v), 10),
          })
        }
      >
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Konto">
            {selectedAccountLabel ?? "Alle Konten"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Alle Konten</SelectItem>
          {(accounts ?? []).map((a) => (
            <SelectItem key={a.id} value={String(a.id)}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        items={{
          Gebucht: "Gebucht",
          "Nicht gebucht": "Nicht gebucht",
          all: "Alle Status",
        }}
        value={filters.status}
        onValueChange={(v) =>
          onChange({ ...filters, status: String(v) as TableFilters["status"] })
        }
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Gebucht">Gebucht</SelectItem>
          <SelectItem value="Nicht gebucht">Nicht gebucht</SelectItem>
          <SelectItem value="all">Alle Status</SelectItem>
        </SelectContent>
      </Select>

      <Select
        items={{
          all: "Alle Labels",
          pending: "offen",
          labeled: "gelabelt",
          failed: "fehlgeschlagen",
        }}
        value={filters.labelStatus}
        onValueChange={(v) =>
          onChange({
            ...filters,
            labelStatus: String(v) as TableFilters["labelStatus"],
          })
        }
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Alle Labels</SelectItem>
          <SelectItem value="pending">offen</SelectItem>
          <SelectItem value="labeled">gelabelt</SelectItem>
          <SelectItem value="failed">fehlgeschlagen</SelectItem>
        </SelectContent>
      </Select>

      <Button
        variant="ghost"
        size="icon"
        title="Filter zurücksetzen"
        onClick={() => {
          setQDraft("")
          onChange(EMPTY_FILTERS)
        }}
      >
        <RotateCcw className="size-4" />
      </Button>
    </div>
  )
}
