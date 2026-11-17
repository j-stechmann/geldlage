/**
 * Generic page envelope (ADR-0037): count, offset/limit and pageCount only.
 *
 * Callers keep their own count/row queries (plans needs joins for search) and
 * map `items` back to their wire key (`rows` / `plans`).
 */
import type { PageRequest, PageResult } from "@/lib/contracts/paging"

export function paginate<T>(
  req: PageRequest,
  count: () => number,
  pageRows: (limit: number, offset: number) => T[]
): PageResult<T> {
  const total = count()
  return {
    items: pageRows(req.pageSize, (req.page - 1) * req.pageSize),
    total,
    page: req.page,
    pageCount: Math.max(1, Math.ceil(total / req.pageSize)),
  }
}
