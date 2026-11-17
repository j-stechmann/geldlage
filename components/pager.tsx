"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Shared prev/next pager used by the server-paged tables (ADR-0037).
 *
 * Copy and pager states differ per table (transactions' "Fokus" deep-link
 * mode, plans' "settling" placeholder), so the callers own `summary` and
 * `indicator`; this component owns only the layout and the disabled/page
 * arithmetic.
 */
export function Pager({
  page,
  pageCount,
  onPageChange,
  summary,
  indicator,
  prevDisabled = false,
  nextDisabled = false,
  className,
}: {
  page: number
  pageCount: number
  onPageChange: (next: number) => void
  summary: React.ReactNode
  indicator: React.ReactNode
  prevDisabled?: boolean
  nextDisabled?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between", className)}>
      <p className="text-sm text-muted-foreground">{summary}</p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={prevDisabled || page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <ChevronLeft className="size-4" /> Zurück
        </Button>
        <span className="text-sm text-muted-foreground tabular-nums">
          {indicator}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={nextDisabled || page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Weiter <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
