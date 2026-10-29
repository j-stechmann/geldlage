"use client"

import * as React from "react"
import { ChevronDown, CalendarClock, CircleDashed, Tag } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TableRow, TableCell } from "@/components/ui/table"
import { resolveCategoryColor } from "@/lib/category-colors"
import { euro } from "@/lib/money"
import { cn } from "@/lib/utils"
import type { ColumnKey } from "@/components/table-columns"
import type { RowActivation } from "@/hooks/use-row-activation"
import type { PlanPrefill } from "@/components/planning/api"

/**
 * Client-side DTO mirroring the /api/transactions row — single source,
 * no inline copies (see components/agent/types.ts convention).
 */
export interface TxRow {
  id: string
  bookingDate: string
  valueDate: string | null
  status: string
  payer: string | null
  payee: string | null
  purpose: string | null
  type: string
  counterpartyIban: string | null
  amountCents: number
  creditorId: string | null
  mandateRef: string | null
  customerRef: string | null
  accountId: number
  accountName: string | null
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  labelStatus: string
}

/** Counterparty in row direction: the payee of outgoing, payer of incoming. */
export function counterpartyOf(row: TxRow): string | null {
  return row.type === "Ausgang" ? row.payee : row.payer
}

/**
 * Derive the plan dialog's create prefill from a booked transaction: the
 * counterparty in row direction (payee of outgoing / payer of incoming),
 * purpose, amount, booking date and account/category. Pure data — the
 * dialog derives direction from the amount sign and guesses a monthly
 * recurrence; no linkage between plan and transaction is stored.
 */
export function planPrefillFromTx(row: TxRow): PlanPrefill {
  return {
    counterparty: counterpartyOf(row),
    purpose: row.purpose,
    amountCents: row.amountCents,
    dtstart: row.bookingDate,
    accountId: row.accountId,
    categoryId: row.categoryId,
  }
}

/**
 * DOM id of a row's expanded detail <tr>, shared by the chevron's
 * aria-controls and the detail row itself.
 */
export function detailRowId(id: string): string {
  return `tx-details-${id}`
}

function CategoryCell({ row }: { row: TxRow }) {
  if (row.labelStatus === "pending") {
    return (
      <Badge
        variant="outline"
        className="gap-1 font-normal text-muted-foreground"
      >
        <CircleDashed className="size-3" /> wird kategorisiert
      </Badge>
    )
  }
  if (row.labelStatus === "failed" || !row.categoryName) {
    return (
      <Badge
        variant="outline"
        className="gap-1 font-normal text-muted-foreground"
      >
        <Tag className="size-3" /> ohne Kategorie
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="category-badge font-normal"
      style={
        {
          "--category-color": resolveCategoryColor(
            row.categoryId,
            row.categoryColor
          ),
        } as React.CSSProperties
      }
    >
      {row.categoryName}
    </Badge>
  )
}

function LabelStatusCell({ status }: { status: string }) {
  if (status === "pending") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        offen
      </Badge>
    )
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="font-normal text-destructive">
        fehlgeschlagen
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      gelabelt
    </Badge>
  )
}

function DetailField({
  label,
  mono,
  span,
  hideEmpty,
  children,
}: {
  label: string
  mono?: boolean
  span?: boolean
  hideEmpty?: boolean
  children: React.ReactNode
}) {
  if (
    hideEmpty &&
    (children === null ||
      (typeof children === "string" && children.trim() === ""))
  )
    return null
  return (
    <div className={cn("space-y-1", span && "@min-[640px]:col-span-2")}>
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          "text-sm break-words whitespace-pre-wrap",
          mono && "font-mono text-xs"
        )}
      >
        {children || "—"}
      </dd>
    </div>
  )
}

/** The clickable main row; expands its detail row via onToggle. */
export const TransactionRow = React.memo(function TransactionRow({
  row,
  expanded,
  visibleSet,
  activation,
  onToggle,
  onAssign,
  focus = false,
}: {
  row: TxRow
  expanded: boolean
  visibleSet: ReadonlySet<ColumnKey>
  activation: RowActivation
  onToggle: (id: string) => void
  onAssign: (row: TxRow) => void
  /** deep-linked row (from the /planung calendar): highlighted + scrolled to */
  focus?: boolean
}) {
  const counterparty = counterpartyOf(row)
  const rowRef = React.useRef<HTMLTableRowElement>(null)
  React.useEffect(() => {
    if (focus) {
      rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [focus])
  return (
    <TableRow
      ref={rowRef}
      data-focus={focus || undefined}
      className={cn(
        "cursor-pointer",
        focus && "bg-accent/40 outline-2 -outline-offset-2 outline-ring/60"
      )}
      onPointerDown={activation.onPointerDown}
      onClick={(e) => {
        // only a plain activation (see use-row-activation) toggles the row
        if (activation.isPlainClick(e)) onToggle(row.id)
      }}
    >
      <TableCell className="w-8">
        <button
          type="button"
          aria-expanded={expanded}
          // only while expanded: the detail <tr> is unmounted when
          // collapsed, and aria-controls referencing a nonexistent element
          // is an ARIA authoring error (aria-expanded carries the state)
          aria-controls={expanded ? detailRowId(row.id) : undefined}
          aria-label={expanded ? "Details ausblenden" : "Details einblenden"}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            // ignore the second click of a double-click so a rapid
            // double-click toggles once, matching the row behavior;
            // keyboard activation (detail 0) is unaffected
            if (e.detail > 1) return
            onToggle(row.id)
          }}
        >
          <ChevronDown
            className={`size-4 transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
        </button>
      </TableCell>
      {visibleSet.has("bookingDate") && (
        <TableCell className="whitespace-nowrap tabular-nums">
          {row.bookingDate}
        </TableCell>
      )}
      {visibleSet.has("valueDate") && (
        <TableCell className="whitespace-nowrap tabular-nums">
          {row.valueDate ?? "—"}
        </TableCell>
      )}
      {visibleSet.has("status") && (
        <TableCell className="whitespace-nowrap">{row.status}</TableCell>
      )}
      {visibleSet.has("counterparty") && (
        <TableCell>
          <div className="max-w-md min-w-0">
            <p className="truncate font-medium">{counterparty || "—"}</p>
          </div>
        </TableCell>
      )}
      {visibleSet.has("purpose") && (
        <TableCell>
          <p className="max-w-md truncate text-sm text-muted-foreground">
            {row.purpose || "—"}
          </p>
        </TableCell>
      )}
      {visibleSet.has("counterpartyIban") && (
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {row.counterpartyIban || "—"}
        </TableCell>
      )}
      {visibleSet.has("type") && (
        <TableCell className="whitespace-nowrap">{row.type}</TableCell>
      )}
      {visibleSet.has("account") && (
        <TableCell className="whitespace-nowrap">
          {row.accountName ?? "—"}
        </TableCell>
      )}
      {visibleSet.has("category") && (
        <TableCell>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center rounded-md transition-colors hover:bg-accent/60"
            onClick={(e) => {
              e.stopPropagation()
              onAssign(row)
            }}
            title="Kategorie zuweisen"
          >
            <CategoryCell row={row} />
          </button>
        </TableCell>
      )}
      {visibleSet.has("labelStatus") && (
        <TableCell className="whitespace-nowrap">
          <LabelStatusCell status={row.labelStatus} />
        </TableCell>
      )}
      {visibleSet.has("creditorId") && (
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {row.creditorId || "—"}
        </TableCell>
      )}
      {visibleSet.has("mandateRef") && (
        <TableCell className="max-w-40 truncate font-mono text-xs">
          {row.mandateRef || "—"}
        </TableCell>
      )}
      {visibleSet.has("customerRef") && (
        <TableCell className="max-w-40 truncate font-mono text-xs">
          {row.customerRef || "—"}
        </TableCell>
      )}
      {visibleSet.has("amountCents") && (
        <TableCell
          className={`text-right font-medium whitespace-nowrap tabular-nums ${
            row.amountCents < 0
              ? "text-foreground"
              : "text-emerald-600 dark:text-emerald-400"
          }`}
        >
          {euro(row.amountCents)}
        </TableCell>
      )}
    </TableRow>
  )
})

/** The expanded detail row: the visible cell values as a definition list,
 * multi-line Verwendungszweck included (whitespace-pre-wrap). Optional
 * fields are hidden when empty via DetailField. An optional action footer
 * carries the "convert to planned transaction" entry (the plan dialog opens
 * pre-filled with this row's data).
 */
export function TransactionDetailRow({
  row,
  colSpan,
  onConvertToPlan,
}: {
  row: TxRow
  colSpan: number
  onConvertToPlan?: (row: TxRow) => void
}) {
  const counterparty = counterpartyOf(row)
  return (
    <TableRow className="hover:bg-transparent" id={detailRowId(row.id)}>
      <TableCell colSpan={colSpan} className="p-0 whitespace-normal">
        <div className="mx-2 mb-2 rounded-md border border-border/50 bg-muted/40 p-4">
          <dl className="grid gap-x-8 gap-y-3 @min-[640px]:grid-cols-2">
            <DetailField label="Vertragspartner" span>
              <span className="font-medium">{counterparty || "—"}</span>
            </DetailField>
            <DetailField label="Verwendungszweck" span>
              {row.purpose}
            </DetailField>
            <DetailField label="IBAN" mono>
              {row.counterpartyIban}
            </DetailField>
            <DetailField label="Gläubiger-ID" mono hideEmpty>
              {row.creditorId}
            </DetailField>
            <DetailField label="Mandatsreferenz" mono hideEmpty>
              {row.mandateRef}
            </DetailField>
            <DetailField label="Kundenreferenz" mono hideEmpty>
              {row.customerRef}
            </DetailField>
            <DetailField label="Typ">{row.type}</DetailField>
            <DetailField label="Konto">{row.accountName}</DetailField>
            <DetailField label="Kategorie">
              <CategoryCell row={row} />
            </DetailField>
          </dl>
          {onConvertToPlan && (
            <div className="mt-3 flex justify-end border-t border-border/50 pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  // the detail <tr> sits in the main row's click handling
                  // scope only optically — no accordion toggle should fire
                  e.stopPropagation()
                  onConvertToPlan(row)
                }}
                title="Aus dieser Buchung eine geplante Transaktion mit einem monatlichen Takt anlegen"
              >
                <CalendarClock data-icon="inline-start" />
                In Planung umwandeln
              </Button>
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}
