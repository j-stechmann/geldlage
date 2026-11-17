/**
 * Shared page contract (ADR-0037).
 *
 * `PageResult` is the generic count/offset/pageCount envelope; callers keep
 * their domain JSON keys (`rows` vs `plans`) by mapping `items` at the edge.
 */

export interface PageRequest {
  page: number
  pageSize: number
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  pageCount: number
}
