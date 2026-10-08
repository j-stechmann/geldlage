import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  like,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import { getDb } from "@/lib/db"
import { accounts, categories, transactions } from "@/lib/db/schema"

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

/** escape LIKE wildcards in user input; match with LIKE ... ESCAPE '\' */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1")
}

export function buildWhere(
  f: TransactionFilters,
  userId: number
): SQL | undefined {
  const conditions: SQL[] = [eq(transactions.userId, userId)]
  if (f.status !== "all") {
    conditions.push(eq(transactions.status, f.status ?? "Gebucht"))
  }
  if (f.q) {
    const escaped = `%${escapeLike(f.q)}%`
    const cond = or(
      like(transactions.payee, escaped),
      like(transactions.payer, escaped),
      like(transactions.purpose, escaped)
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

export interface TransactionPage {
  rows: Array<{
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
  }>
  total: number
  page: number
  pageCount: number
}

export function queryTransactions(
  f: TransactionFilters,
  userId: number,
  page: number,
  pageSize: number
): TransactionPage {
  const db = getDb()
  const where = buildWhere(f, userId)

  const total =
    db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(where)
      .get()?.count ?? 0

  const rows = db
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
    .where(where)
    .orderBy(...buildOrderBy(f))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  }
}
