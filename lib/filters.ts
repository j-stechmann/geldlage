export interface TableFilters {
  q: string
  dateFrom: string | null
  dateTo: string | null
  type: "Ausgang" | "Eingang" | "all"
  categoryIds: number[]
  accountId: number | null
  status: "Gebucht" | "Nicht gebucht" | "all"
  labelStatus: "pending" | "labeled" | "failed" | "all"
}

export const EMPTY_FILTERS: TableFilters = {
  q: "",
  dateFrom: null,
  dateTo: null,
  type: "all",
  categoryIds: [],
  accountId: null,
  status: "Gebucht",
  labelStatus: "all",
}

/** serialize filters for analytics/transactions query strings */
export function filtersToParams(f: TableFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (f.q) sp.set("q", f.q)
  if (f.dateFrom) sp.set("dateFrom", f.dateFrom)
  if (f.dateTo) sp.set("dateTo", f.dateTo)
  if (f.type !== "all") sp.set("type", f.type)
  for (const id of f.categoryIds) sp.append("categoryId", String(id))
  if (f.accountId !== null) sp.set("accountId", String(f.accountId))
  if (f.status !== "Gebucht") sp.set("status", f.status)
  if (f.labelStatus !== "all") sp.set("labelStatus", f.labelStatus)
  return sp
}

/** inverse of filtersToParams; ignores unknown/invalid values */
export function paramsToFilters(sp: URLSearchParams): TableFilters {
  const f: TableFilters = { ...EMPTY_FILTERS, categoryIds: [] }
  f.q = sp.get("q")?.trim() ?? ""
  const dateFrom = sp.get("dateFrom")
  if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) f.dateFrom = dateFrom
  const dateTo = sp.get("dateTo")
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) f.dateTo = dateTo
  const type = sp.get("type")
  if (type === "Ausgang" || type === "Eingang") f.type = type
  f.categoryIds = sp
    .getAll("categoryId")
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0)
  const accountId = Number.parseInt(sp.get("accountId") ?? "", 10)
  if (Number.isInteger(accountId) && accountId > 0) f.accountId = accountId
  const status = sp.get("status")
  if (status === "Gebucht" || status === "Nicht gebucht" || status === "all") {
    f.status = status
  }
  const labelStatus = sp.get("labelStatus")
  if (
    labelStatus === "pending" ||
    labelStatus === "labeled" ||
    labelStatus === "failed" ||
    labelStatus === "all"
  ) {
    f.labelStatus = labelStatus
  }
  return f
}
