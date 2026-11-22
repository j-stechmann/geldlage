import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import { getDb } from "@/lib/db"
import { escapeLike, likeEscaped } from "@/lib/db/search"
import { paginate } from "@/lib/pagination"
import { accounts, categories, transactions } from "@/lib/db/schema"
import type {
  CalendarTransaction,
  TransactionPage,
} from "@/lib/contracts/transactions"
import { counterpartyOf } from "@/lib/transactions"
import { buildTransactionScope } from "@/lib/analytics/scope"

export type SortField =
  "booking_date" | "value_date" | "amount_cents" | "payee" | "status"

export interface TransactionFilters {
  q?: string
  dateFrom?: string
  dateTo?: string
  type?: "Ausgang" | "Eingang"
  categoryIds?: number[]
  accountId?: number
  labelStatus?: "pending" | "labeled" | "failed"
  /** default 'Gebucht'; 'all' disables the filter */
  status?: string
  sort?: SortField
  dir?: "asc" | "desc"
}

export function parseFilters(sp: URLSearchParams): TransactionFilters {
  const q = sp.get("q")?.trim() || undefined
  const dateFrom = sp.get("dateFrom") || undefined
  const dateTo = sp.get("dateTo") || undefined
  const typeRaw = sp.get("type")
  const type =
    typeRaw === "Ausgang" || typeRaw === "Eingang" ? typeRaw : undefined
  const categoryIds = sp
    .getAll("categoryId")
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0)
  const accountIdRaw = sp.get("accountId")
  const accountIdParsed = Number.parseInt(accountIdRaw ?? "", 10)
  const accountId =
    accountIdRaw && Number.isInteger(accountIdParsed) && accountIdParsed > 0
      ? accountIdParsed
      : undefined
  const labelStatusRaw = sp.get("labelStatus")
  const labelStatus =
    labelStatusRaw === "pending" ||
    labelStatusRaw === "labeled" ||
    labelStatusRaw === "failed"
      ? labelStatusRaw
      : undefined
  const status = sp.get("status") || "Gebucht"
  const sortRaw = sp.get("sort")
  const sort: SortField =
    sortRaw === "amount_cents" ||
    sortRaw === "payee" ||
    sortRaw === "value_date" ||
    sortRaw === "status"
      ? sortRaw
      : "booking_date"
  const dir = sp.get("dir") === "asc" ? "asc" : "desc"
  return {
    q,
    dateFrom,
    dateTo,
    type,
    categoryIds,
    accountId,
    labelStatus,
    status,
    sort,
    dir,
  }
}

/**
 * Free-text search over payee/payer/purpose. Uses the shared SQL search
 * helpers so `%`/`_` stay literal (drizzle's `like()` cannot emit the ESCAPE
 * clause); case folding stays ASCII-only here because this scan covers the
 * full booking history (`likeEscapedFolded` would add a JS call per row).
 */
export function buildWhere(
  f: TransactionFilters,
  userId: number
): SQL | undefined {
  const conditions: SQL[] = [eq(transactions.userId, userId)]
  if (f.status !== "all") {
    conditions.push(eq(transactions.status, f.status ?? "Gebucht"))
  }
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`
    const cond = or(
      likeEscaped(transactions.payee, pattern),
      likeEscaped(transactions.payer, pattern),
      likeEscaped(transactions.purpose, pattern)
    )
    if (cond) conditions.push(cond)
  }
  if (f.dateFrom) conditions.push(gte(transactions.bookingDate, f.dateFrom))
  if (f.dateTo) conditions.push(lte(transactions.bookingDate, f.dateTo))
  if (f.type) conditions.push(eq(transactions.type, f.type))
  if (f.categoryIds && f.categoryIds.length > 0) {
    conditions.push(inArray(transactions.categoryId, f.categoryIds))
  }
  if (f.accountId !== undefined) {
    conditions.push(eq(transactions.accountId, f.accountId))
  }
  if (f.labelStatus) {
    conditions.push(eq(transactions.labelStatus, f.labelStatus))
  }
  return conditions.length > 0 ? and(...conditions) : undefined
}

export function buildOrderBy(f: TransactionFilters) {
  const dir = f.dir === "asc" ? asc : desc
  switch (f.sort) {
    case "amount_cents":
      return [dir(transactions.amountCents), desc(transactions.bookingDate)]
    case "payee":
      return [dir(transactions.payee), desc(transactions.bookingDate)]
    case "value_date":
      return [dir(transactions.valueDate), desc(transactions.bookingDate)]
    case "status":
      return [dir(transactions.status), desc(transactions.bookingDate)]
    default:
      return [dir(transactions.bookingDate), desc(transactions.amountCents)]
  }
}

/** The shared row projection of both transactions queries. */
function txRowSelect() {
  const db = getDb()
  return db
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      valueDate: transactions.valueDate,
      status: transactions.status,
      payer: transactions.payer,
      payee: transactions.payee,
      purpose: transactions.purpose,
      type: transactions.type,
      counterpartyIban: transactions.counterpartyIban,
      amountCents: transactions.amountCents,
      creditorId: transactions.creditorId,
      mandateRef: transactions.mandateRef,
      customerRef: transactions.customerRef,
      accountId: transactions.accountId,
      accountName: accounts.name,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      labelStatus: transactions.labelStatus,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .leftJoin(accounts, eq(transactions.accountId, accounts.id))
}

export function queryTransactions(
  f: TransactionFilters,
  userId: number,
  page: number,
  pageSize: number
): TransactionPage {
  const db = getDb()
  const where = buildWhere(f, userId)

  const result = paginate(
    { page, pageSize },
    () =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(transactions)
        .where(where)
        .get()?.count ?? 0,
    (limit, offset) =>
      txRowSelect()
        .where(where)
        .orderBy(...buildOrderBy(f))
        .limit(limit)
        .offset(offset)
        .all()
  )

  return {
    rows: result.items,
    total: result.total,
    page: result.page,
    pageCount: result.pageCount,
  }
}

/**
 * Compact bank rows for a calendar window — both booked and pending rows.
 *
 * Deliberately has its own allowlist instead of `buildWhere`: the flow filter
 * defaults to `Gebucht` and accepts content filters that must never apply to
 * the calendar chip query (ADR-0022/0037). It shares the generic user/
 * account/date scaffold with the balance predicate but supplies its own
 * booked-and-pending status list. Ordering by booking date matches the
 * previous route-level query.
 */
export function queryCalendarTransactions(
  userId: number,
  window: { from: string; to: string },
  accountId?: number
): CalendarTransaction[] {
  const db = getDb()
  const where = buildTransactionScope({
    userId,
    accountId,
    statuses: ["Gebucht", "Nicht gebucht"],
    dateBounds: { from: window.from, to: window.to },
  })

  const rows = db
    .select({
      id: transactions.id,
      date: transactions.bookingDate,
      status: transactions.status,
      type: transactions.type,
      payer: transactions.payer,
      payee: transactions.payee,
      purpose: transactions.purpose,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(where)
    .orderBy(transactions.bookingDate)
    .all()

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    status: r.status as CalendarTransaction["status"],
    counterparty: counterpartyOf(r),
    purpose: r.purpose,
    amountCents: r.amountCents,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    categoryColor: r.categoryColor,
    accountId: r.accountId,
  }))
}

/**
 * Precise single-row lookup (deep link from the /calendar page):
 * user-scoped, ignores every other filter — a miss or a foreign id is an
 * empty page, never a leak.
 */
export function queryTransactionById(
  id: string,
  userId: number
): TransactionPage {
  const row = txRowSelect()
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .get()
  return {
    rows: row ? [row] : [],
    total: row ? 1 : 0,
    page: 1,
    pageCount: 1,
  }
}
