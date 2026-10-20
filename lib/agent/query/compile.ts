import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm"
import type { SQL, SQLWrapper } from "drizzle-orm"
import { QUERY_MAX_CELL_CHARS } from "@/lib/agent/constants"
import { queryTables } from "./catalog"
import { outputKey } from "./parse"
import type { ParsedQuery, QueryAggregateFn, QueryCondition } from "./parse"
import { getReadOnlyDb } from "./readonly-db"

/**
 * The query DSL compiler (ADR-0034): turns a parsed (whitelist-validated)
 * query into one SELECT executed on the read-only connection. Identifier
 * chunks (tables, columns, join predicates, aliases) render exclusively
 * from catalog constants — the model's JSON never injects SQL text; its
 * values interpolate as bound parameters. There is no code path to a
 * mutating statement here, and the connection behind getReadOnlyDb()
 * refuses writes at the SQLite level besides.
 *
 * Per-user isolation is compiled in twice: the base table's user_id into
 * WHERE, and every joined table's user_id into its ON clause (ON, not
 * WHERE — an unmatched join must keep the row with NULL join columns,
 * e.g. uncategorized transactions — a WHERE there would drop it).
 */

/** One resolved column reference: expression + result key. */
interface ResolvedRef {
  expr: SQLWrapper
  key: string
}

export interface QueryResult {
  /** result keys in row objects, in SELECT order */
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  /** the effective row limit that produced this result */
  limit: number
  /** present only when more rows matched than the limit allowed */
  limited?: true
  /** exact match count for row queries that hit the limit */
  totalMatching?: number
}

/** Aggregate expression. `sum` coalesces to 0 (empty set reads as 0). */
function aggregateSql(fn: QueryAggregateFn, col: SQLWrapper | undefined): SQL {
  if (fn === "count") {
    return col === undefined ? sql`count(*)` : sql`count(${col})`
  }
  // parse guarantees a column for the remaining functions
  if (fn === "sum") return sql`coalesce(sum(${col}), 0)`
  if (fn === "avg") return sql`avg(${col})`
  if (fn === "min") return sql`min(${col})`
  return sql`max(${col})`
}

/** Parameterized comparison. `contains` escapes % _ \\ in the value. */
function conditionSql(cond: QueryCondition, ref: ResolvedRef): SQL {
  const v = cond.value as string | number | Array<string | number>
  switch (cond.op) {
    case "eq":
      return eq(ref.expr, v)
    case "ne":
      return ne(ref.expr, v)
    case "gt":
      return gt(ref.expr, v)
    case "gte":
      return gte(ref.expr, v)
    case "lt":
      return lt(ref.expr, v)
    case "lte":
      return lte(ref.expr, v)
    case "contains": {
      // literal substring match: model wildcards must not leak through
      const escaped = String(v).replace(/[\\%_]/g, "\\$&")
      return sql`${ref.expr} LIKE ${`%${escaped}%`} ESCAPE ${sql.raw("'\\'")}`
    }
    case "like":
      return sql`${ref.expr} LIKE ${v as string}`
    case "in":
      return inArray(ref.expr, v as Array<string | number>)
    case "isNull":
      return isNull(ref.expr)
    case "notNull":
      return isNotNull(ref.expr)
  }
}

/** Having filters aggregate aliases only (parse guarantees existence). */
function havingSql(cond: QueryCondition, ref: ResolvedRef): SQL {
  const value = cond.value as number
  switch (cond.op) {
    case "eq":
      return eq(ref.expr, value)
    case "ne":
      return ne(ref.expr, value)
    case "gt":
      return gt(ref.expr, value)
    case "gte":
      return gte(ref.expr, value)
    case "lt":
      return lt(ref.expr, value)
    case "lte":
      return lte(ref.expr, value)
    // unreachable: parse restricts having to the six ops above
    default:
      throw new Error(`invalid query: having cannot use op '${cond.op}'`)
  }
}

/**
 * Compiles and runs the query synchronously (better-sqlite3). Errors
 * (SQLite-level, e.g. an ORDER BY column not in GROUP BY) propagate to
 * the tool executor and surface as `{"error": …}` for self-correction.
 */
export function runQuery(q: ParsedQuery, uid: number): QueryResult {
  const def = queryTables[q.table]
  const db = getReadOnlyDb()

  // every joined alias used anywhere in the query (insertion order)
  const usedJoins = new Set<string>()

  function resolve(ref: string): ResolvedRef {
    const dot = ref.indexOf(".")
    if (dot === -1) {
      return { expr: def.columns[ref].expr, key: ref }
    }
    const alias = ref.slice(0, dot)
    const name = ref.slice(dot + 1)
    usedJoins.add(alias)
    const target = queryTables[def.joins[alias].target]
    return { expr: target.columns[name].expr, key: outputKey(ref) }
  }

  // ── resolve ALL clause references first (SELECT, WHERE, groupBy,
  // orderBy) so the join list below is complete when it materializes —
  // a joined column may only be referenced in orderBy/groupBy ───────────
  const aggExprs = new Map<string, SQLWrapper>()
  const selections: ResolvedRef[] = []
  if (q.aggregate.length > 0) {
    for (const a of q.aggregate) {
      aggExprs.set(
        a.alias,
        aggregateSql(
          a.fn,
          a.column === undefined ? undefined : resolve(a.column).expr
        )
      )
    }
    for (const ref of q.groupBy) selections.push(resolve(ref))
    for (const a of q.aggregate) {
      selections.push({ expr: aggExprs.get(a.alias)!, key: a.alias })
    }
  } else {
    for (const ref of q.select ?? Object.keys(def.columns)) {
      selections.push(resolve(ref))
    }
  }

  // ── WHERE: forced user scope + model conditions (+ OR group) ─────────
  const whereConds: SQL[] = [eq(def.userIdColumn, uid)]
  for (const cond of q.where) {
    whereConds.push(conditionSql(cond, resolve(cond.column)))
  }
  if (q.whereAny.length > 0) {
    whereConds.push(
      or(...q.whereAny.map((c) => conditionSql(c, resolve(c.column))))!
    )
  }
  const whereSql = and(...whereConds) as SQL

  const groupExprs = q.groupBy.map((r) => resolve(r).expr)
  const orderItems = q.orderBy.map((o) => {
    const alias = aggExprs.get(o.column)
    return {
      expr: alias !== undefined ? alias : resolve(o.column).expr,
      direction: o.direction,
    }
  })

  // ── JOINs (every reference resolved above, so the set is complete) ───
  const joinChunks: SQL[] = []
  for (const alias of usedJoins) {
    const jd = def.joins[alias]
    const target = queryTables[jd.target]
    joinChunks.push(
      sql`LEFT JOIN ${target.table} ON ${
        and(
          jd.on,
          eq(target.userIdColumn, uid) // join targets are user-scoped too
        ) as SQL
      }`
    )
  }

  // ── assemble ─────────────────────────────────────────────────────────
  const parts: SQL[] = [
    sql`SELECT ${sql.join(
      selections.map((s) => sql`${s.expr} AS ${sql.identifier(s.key)}`),
      sql`, `
    )}`,
    sql`FROM ${def.table}`,
    ...joinChunks,
    sql`WHERE ${whereSql}`,
  ]
  if (groupExprs.length > 0) {
    parts.push(sql`GROUP BY ${sql.join(groupExprs, sql`, `)}`)
  }
  if (q.having.length > 0) {
    parts.push(
      sql`HAVING ${
        and(
          ...q.having.map((h) =>
            havingSql(h, {
              expr: aggExprs.get(h.column)! as SQLWrapper,
              key: h.column,
            })
          )
        ) as SQL
      }`
    )
  }
  // Row queries always end with a rowid tie-break: without an explicit
  // ORDER BY a limited subset would be arbitrary (a retry could return
  // different rows of the same match count), and with one, rows equal on
  // the model's keys sort stably across calls. Aggregate mode keeps
  // model-specified order only — rowid is meaningless per group.
  const orderTerms = orderItems.map((o) =>
    o.direction === "desc" ? sql`${o.expr} DESC` : sql`${o.expr} ASC`
  )
  if (q.aggregate.length === 0) {
    orderTerms.push(sql`${def.table}.rowid ASC`)
  }
  if (orderTerms.length > 0) {
    parts.push(sql`ORDER BY ${sql.join(orderTerms, sql`, `)}`)
  }
  // +1 row: detects "more matched than returned" without a second query
  parts.push(sql`LIMIT ${q.limit + 1}`)

  const rawRows = db.all<Record<string, unknown>>(sql.join(parts, sql.raw(" ")))
  const limited = rawRows.length > q.limit
  const kept = limited ? rawRows.slice(0, q.limit) : rawRows

  let totalMatching: number | undefined
  if (limited && q.aggregate.length === 0) {
    // exact count for row queries (joins preserved — they carry model
    // conditions on joined columns); aggregate/group counts differ in
    // meaning and stay unreported rather than misleading.
    const countChunks = [
      sql`SELECT count(*) AS ${sql.identifier("n")}`,
      sql`FROM ${def.table}`,
      ...joinChunks,
      sql`WHERE ${whereSql}`,
    ]
    totalMatching =
      db.all<{ n: number }>(sql.join(countChunks, sql.raw(" ")))[0]?.n ?? 0
  }

  const rows = kept.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      out[key] =
        typeof value === "string" && value.length > QUERY_MAX_CELL_CHARS
          ? // slice leaves room for the ellipsis: the cap is exact, not +1
            value.slice(0, QUERY_MAX_CELL_CHARS - 1) + "…"
          : value
    }
    return out
  })

  return {
    columns: selections.map((s) => s.key),
    rows,
    rowCount: rows.length,
    limit: q.limit,
    ...(limited ? { limited: true as const } : {}),
    ...(totalMatching !== undefined ? { totalMatching } : {}),
  }
}
