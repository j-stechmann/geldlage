/**
 * Generic page envelope (ADR-0037): count, offset/limit and pageCount only.
 *
 * Callers keep their own count/row queries (plans needs joins for search) and
 * map `items` back to their wire key (`rows` / `plans`).
 *
 * better-sqlite3 binds JS numbers as REAL; SQLite accepts an OFFSET within
 * its signed 64-bit range and rejects anything at or above 2^63 with
 * "datatype mismatch". Such a page cannot match a row anyway, so answer an
 * empty page and echo the requested number instead of querying.
 */
import type { PageRequest, PageResult } from "@/lib/contracts/paging"

const SQLITE_INT64_OFFSET_LIMIT = 2 ** 63

export function paginate<T>(
  req: PageRequest,
  count: () => number,
  pageRows: (limit: number, offset: number) => T[]
): PageResult<T> {
  const total = count()
  const offset = (req.page - 1) * req.pageSize
  const representable =
    Number.isFinite(offset) && offset < SQLITE_INT64_OFFSET_LIMIT
  return {
    items: representable ? pageRows(req.pageSize, offset) : [],
    total,
    page: req.page,
    pageCount: Math.max(1, Math.ceil(total / req.pageSize)),
  }
}
