import { and, eq, gte, lt } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import type { AgentTool, ToolContext } from "@/lib/agent/types"

/**
 * The `get_category_totals` tool (ADR-0033): read-only per-user category
 * sums for a UI-visible period. Executes against the asking user's own
 * data (ctx.uid scoping — in shared threads the results reflect whoever
 * the loop executes for, never another member's data) and returns plain
 * serializable JSON. The booking status is filterable (`Gebucht` /
 * `Nicht gebucht` / `both`) and defaults to `Gebucht` so the tool's
 * default matches the transactions table and analytics views.
 *
 * Uncategorized transactions (label_status pending/failed, or a category
 * deleted since) fold into one "Ohne Kategorie" bucket and count toward
 * `totalsCents`: the analytics views sum every filtered transaction with
 * no category predicate (lib/analytics/engine.ts buildWhere), so the
 * tool's totals must not silently drop them.
 */

/** Label of the synthetic bucket for rows without a resolvable category. */
const UNCATEGORIZED = "Ohne Kategorie"

/** UI-visible periods the tool accepts (validated against before querying). */
export type CategoryTotalsPeriod = "this_month" | "last_month" | "last_90_days"

const PERIODS: readonly CategoryTotalsPeriod[] = [
  "this_month",
  "last_month",
  "last_90_days",
]

function isPeriod(v: unknown): v is CategoryTotalsPeriod {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v)
}

/** Booking status filter ("both" disables the status condition entirely). */
export type CategoryTotalsStatus = "Gebucht" | "Nicht gebucht" | "both"

const STATUSES: readonly CategoryTotalsStatus[] = [
  "Gebucht",
  "Nicht gebucht",
  "both",
]

function isStatus(v: unknown): v is CategoryTotalsStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v)
}

/**
 * First day (ISO) of the period start boundary, computed in local time:
 * booking dates are stored as `YYYY-MM-DD` strings (parseGermanDateToIso),
 * so string comparison against the boundaries is exact calendar math
 * — no timezone drift and index-friendly.
 */
export function periodStartDate(
  period: CategoryTotalsPeriod,
  now: Date
): string {
  const y = now.getFullYear()
  const m = now.getMonth()
  if (period === "this_month") {
    return isoDay(y, m, 1)
  }
  if (period === "last_month") {
    const firstPrev = new Date(y, m - 1, 1)
    return isoDay(firstPrev.getFullYear(), firstPrev.getMonth(), 1)
  }
  // last_90_days: today minus 90 days (rolling window, not calendar months)
  const start = new Date(y, m, now.getDate() - 90)
  return isoDay(start.getFullYear(), start.getMonth(), start.getDate())
}

/**
 * Exclusive upper bound for bounded periods (ISO). last_month must not
 * sweep in this month's rows (a `gte` start alone would) and stays
 * closed at the 1st. this_month and last_90_days run through the END
 * of the current month instead of "now": vorgemerkte ("Nicht gebucht")
 * rows carry post-dated booking dates (bank processing lag), so a
 * window ending today would silently drop them — "Was ist diesen
 * Monat noch vorgemerkt?" would undercount. Rows dated next month are
 * that month's business and stay excluded.
 */
export function periodEndDate(period: CategoryTotalsPeriod, now: Date): string {
  if (period === "last_month") {
    return isoDay(now.getFullYear(), now.getMonth(), 1)
  }
  // this_month / last_90_days: 1st of the next month (exclusive);
  // Date(y, m+1, 1) rolls the year over December on its own.
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return isoDay(next.getFullYear(), next.getMonth(), 1)
}

function isoDay(y: number, m: number, d: number): string {
  const mm = String(m + 1).padStart(2, "0")
  const dd = String(d).padStart(2, "0")
  return `${y}-${mm}-${dd}`
}

interface CategoryTotal {
  category: string
  inflowCents: number
  outflowCents: number
  count: number
}

export interface CategoryTotalsResult {
  period: CategoryTotalsPeriod
  status: CategoryTotalsStatus
  categories: CategoryTotal[]
  totalsCents: { inflow: number; outflow: number }
}

// `as const` on name keeps the literal type so tool-registry's
// AgentToolName union derives from the registry (a tool declaration with
// `name: string` would silently widen the derived union to string).
export const get_category_totals = {
  name: "get_category_totals" as const,
  description:
    "Liefert Summen (Einnahmen/Ausgaben) und Transaktionsanzahl pro Kategorie für den Sitzungsbenutzer. Wähle eine Periode: this_month, last_month oder last_90_days. Optional filter nach Buchungsstatus: Gebucht (Standard), Nicht gebucht (vorgemerkt) oder both. Nicht kategorisierte Transaktionen laufen unter „Ohne Kategorie“ auf und zählen zu den Gesamtsummen. Beträge in Cent (Integer).",
  parameters: {
    type: "object",
    properties: {
      period: {
        type: "string",
        enum: ["this_month", "last_month", "last_90_days"],
      },
      status: {
        type: "string",
        enum: ["Gebucht", "Nicht gebucht", "both"],
        description:
          "Buchungsstatus der Transaktionen. Standard: Gebucht — nur final gebuchte Umsätze. „Nicht gebucht“ = vorgemerkte Umsätze. „both“ = beides zusammen.",
      },
    },
    required: ["period"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    const raw = (args ?? null) as {
      period?: unknown
      status?: unknown
    } | null
    const period = raw?.period
    const status = raw?.status === undefined ? "Gebucht" : raw.status
    if (!isPeriod(period) || !isStatus(status)) {
      throw new Error("invalid args")
    }
    const now = new Date()
    const start = periodStartDate(period, now)
    const end = periodEndDate(period, now)

    // Select-and-fold instead of SQL GROUP BY with signed CASE aggregates:
    // rows are per-user and small (local bank data), and folding in TS keeps
    // every number an integer cent end-to-end while letting one pass build
    // both per-category splits and grand totals. A drizzle sql`` CASE sum
    // would couple us to raw SQL fragments and still need a second query
    // for the category names.
    const db = getDb()
    const rows = db
      .select({
        amountCents: transactions.amountCents,
        name: categories.name,
      })
      .from(transactions)
      // leftJoin (not inner): rows without a category must reach the fold
      // below so totalsCents matches the analytics views — they never
      // filter on category.
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          eq(transactions.userId, ctx.uid),
          // "both" omits the status condition entirely; a specific status
          // filters exactly it (status strings match the DB and the UI's
          // filter values — the UI's no-filter token is "all", this tool's
          // is "both").
          status === "both" ? undefined : eq(transactions.status, status),
          gte(transactions.bookingDate, start),
          lt(transactions.bookingDate, end)
        )
      )
      .all()

    // Group in JS: name → (inflow, outflow, count). Negative amounts stay
    // negative (outflowCents is reported as a negative sum — the JSON
    // contract says so), positives as inflow. Rows without a category
    // (never labeled, or their category deleted since — deletions reset
    // transactions transactionally, so this is belt-and-braces) share the
    // "Ohne Kategorie" bucket; the join nulls `name` for both. Category
    // names are unique per user ((user_id, name_key) unique index), so
    // only a category literally named "Ohne Kategorie" could collide.
    const byCategory = new Map<string, CategoryTotal>()
    let inflow = 0
    let outflow = 0
    for (const row of rows) {
      const name = row.name ?? UNCATEGORIZED
      let entry = byCategory.get(name)
      if (!entry) {
        entry = {
          category: name,
          inflowCents: 0,
          outflowCents: 0,
          count: 0,
        }
        byCategory.set(name, entry)
      }
      if (row.amountCents < 0) {
        entry.outflowCents += row.amountCents
        outflow += row.amountCents
      } else {
        entry.inflowCents += row.amountCents
        inflow += row.amountCents
      }
      entry.count++
    }

    // Largest absolute movement first so the model's first tokens (and the
    // panel viewport) carry the dominant categories without re-sorting.
    const list = [...byCategory.values()].sort(
      (a, b) =>
        Math.abs(b.inflowCents + b.outflowCents) -
        Math.abs(a.inflowCents + a.outflowCents)
    )

    const result: CategoryTotalsResult = {
      period,
      status,
      categories: list,
      totalsCents: { inflow, outflow },
    }
    return result
  },
} satisfies AgentTool
