import { QUERY_DEFAULT_LIMIT, QUERY_MAX_ROWS } from "@/lib/agent/constants"
import { queryTables, type QueryTableDef } from "./catalog"

/**
 * The query DSL parser (ADR-0034): validates the model's raw JSON args
 * against the catalog whitelist and returns a normalized, typed query —
 * or throws a short, model-readable `{"error": …}` message (the tool
 * executor absorbs thrown errors, so a wrong query self-corrects on the
 * next round instead of failing the turn).
 *
 * Fail-closed by construction: unknown TOP-LEVEL fields, unknown ops,
 * unknown tables/columns/joins, wrong value types, and every size cap
 * are rejected here, before compilation. There is no escape hatch for
 * raw SQL — the DSL vocabulary simply has no field that could carry one.
 */

export const QUERY_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "like",
  "in",
  "isNull",
  "notNull",
] as const

export type QueryOp = (typeof QUERY_OPS)[number]

/** Aggregate functions. sum/avg only make sense on integer columns. */
export const QUERY_AGGREGATE_FNS = [
  "sum",
  "count",
  "avg",
  "min",
  "max",
] as const

export type QueryAggregateFn = (typeof QUERY_AGGREGATE_FNS)[number]

/** Filter on the asking-user's query: `column` is a column ref or alias. */
export interface QueryCondition {
  column: string
  op: QueryOp
  value?: string | number | Array<string | number>
}

export interface QueryAggregate {
  fn: QueryAggregateFn
  column?: string
  /** parse-resolved output alias (default: `${fn}_${column}` or `count`) */
  alias: string
}

export interface QueryOrder {
  column: string
  direction: "asc" | "desc"
}

export interface ParsedQuery {
  table: string
  /** column refs; null = all base columns of the table */
  select: string[] | null
  where: QueryCondition[]
  /** OR-group, AND-ed with `where` */
  whereAny: QueryCondition[]
  aggregate: QueryAggregate[]
  groupBy: string[]
  /** conditions over aggregate aliases only */
  having: QueryCondition[]
  orderBy: QueryOrder[]
  /** already clamped to QUERY_MAX_ROWS */
  limit: number
}

/** Size caps: no query the model produces may be pathological. */
const MAX_CONDITIONS = 20
const MAX_IN_ITEMS = 100
const MAX_SELECT = 64
const MAX_GROUP_BY = 5
const MAX_ORDER_BY = 5
const MAX_AGGREGATES = 8

/** Aggregate aliases become SQL identifiers — strict shape, hard length. */
const ALIAS_RE = /^[a-z][a-z0-9_]{0,39}$/i

function fail(msg: string): never {
  throw new Error(`invalid query: ${msg}`)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Checks a column ref (base or `alias.column` and validates it) exists. */
function checkRef(def: QueryTableDef, table: string, ref: unknown): string {
  if (typeof ref !== "string" || ref.length === 0) {
    fail("column reference must be a non-empty string")
  }
  const dot = ref.indexOf(".")
  if (dot === -1) {
    if (!Object.hasOwn(def.columns, ref)) {
      fail(
        `unknown column '${ref}' in table '${table}' (columns: ${Object.keys(def.columns).join(", ")})`
      )
    }
    return ref
  }
  const alias = ref.slice(0, dot)
  const name = ref.slice(dot + 1)
  // Object.hasOwn: see the table check in parseQuery — inherited names
  // must fail closed here, not pass as truthy prototype members.
  if (!Object.hasOwn(def.joins, alias)) {
    const avail = Object.keys(def.joins)
    fail(
      `unknown join alias '${alias}' in '${ref}' (available: ${avail.join(", ") || "none"})`
    )
  }
  const targetDef = queryTables[def.joins[alias].target]
  if (!Object.hasOwn(targetDef.columns, name)) {
    fail(
      `unknown column '${name}' in joined table '${def.joins[alias].target}' ('${ref}')`
    )
  }
  return ref
}

function columnKind(def: QueryTableDef, ref: string): "text" | "integer" {
  const dot = ref.indexOf(".")
  if (dot === -1) return def.columns[ref].kind
  const join = def.joins[ref.slice(0, dot)]
  return queryTables[join.target].columns[ref.slice(dot + 1)].kind
}

function checkValue(
  op: QueryOp,
  kind: "text" | "integer",
  raw: unknown
): string | number | Array<string | number> | undefined {
  if (op === "isNull" || op === "notNull") {
    if (raw !== undefined) fail(`op '${op}' takes no value`)
    return undefined
  }
  if (op === "in") {
    if (!Array.isArray(raw) || raw.length === 0) {
      fail(`op 'in' needs a non-empty array value`)
    }
    if (raw.length > MAX_IN_ITEMS)
      fail(`'in' accepts at most ${MAX_IN_ITEMS} items`)
    for (const item of raw) {
      if (
        kind === "integer" &&
        !(typeof item === "number" && Number.isInteger(item))
      ) {
        fail(
          `'in' values for integer columns must be integers (got ${JSON.stringify(item)})`
        )
      }
      if (kind === "text" && typeof item !== "string") {
        fail(
          `'in' values for text columns must be strings (got ${JSON.stringify(item)})`
        )
      }
    }
    return raw
  }
  if (
    kind === "integer" &&
    !(typeof raw === "number" && Number.isInteger(raw))
  ) {
    fail(
      `value for integer column with op '${op}' must be an integer (got ${JSON.stringify(raw)})`
    )
  }
  if (kind === "text" && typeof raw !== "string") {
    fail(
      `value for text column with op '${op}' must be a string (got ${JSON.stringify(raw)})`
    )
  }
  return raw as string | number
}

function checkKeys(
  raw: Record<string, unknown>,
  allowed: string[],
  what: string
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      fail(
        `${what} has unknown field '${key}' (allowed: ${allowed.join(", ")})`
      )
    }
  }
}

function parseCondition(
  raw: unknown,
  def: QueryTableDef,
  table: string,
  field: string,
  index: number
): QueryCondition {
  if (!isPlainObject(raw)) fail(`${field}[${index}] must be an object`)
  checkKeys(raw, ["column", "op", "value"], `${field}[${index}]`)
  const column = checkRef(def, table, raw.column)
  const op = raw.op
  if (
    typeof op !== "string" ||
    !(QUERY_OPS as readonly string[]).includes(op)
  ) {
    fail(`${field}[${index}].op must be one of: ${QUERY_OPS.join(", ")}`)
  }
  const kind = columnKind(def, column)
  // contains/like compile to LIKE text matching — on an integer column the
  // comparison would coerce to text and effectively match nothing. Fail at
  // parse time so the model redirects to eq/gt/lt/in instead of guessing.
  if (op === "like" || op === "contains") {
    if (kind === "integer") {
      fail(
        `op '${op}' needs a text column ('${column}' is integer — compare with eq/gt/lt/in)`
      )
    }
  }
  const value = checkValue(op as QueryOp, kind, raw.value)
  return { column, op: op as QueryOp, value }
}

function parseConditions(
  raw: unknown,
  def: QueryTableDef,
  table: string,
  field: string
): QueryCondition[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail(`${field} must be an array of conditions`)
  if (raw.length > MAX_CONDITIONS) {
    fail(`${field} accepts at most ${MAX_CONDITIONS} conditions`)
  }
  return raw.map((item, i) => parseCondition(item, def, table, field, i))
}

/** Default output alias, also used for uniqueness checks. */
function aggregateAlias(fn: QueryAggregateFn, column?: string): string {
  return column ? `${fn}_${column.replace(/\./g, "_")}` : fn
}

/**
 * The compiled output key a column ref produces (base ref → itself,
 * joined "alias.col" → "alias_col"; matches the FIRST dot only, same as
 * the compiler's key construction). Shared with the compiler so row
 * objects keep the documented columns/SELECT-order contract and no
 * label can repeat.
 */
export function outputKey(ref: string): string {
  const dot = ref.indexOf(".")
  return dot === -1 ? ref : `${ref.slice(0, dot)}_${ref.slice(dot + 1)}`
}

/**
 * Validates the model args and returns the normalized query. Throws
 * `invalid query: …` (absorbed into the tool result by the executor).
 */
export function parseQuery(raw: unknown): ParsedQuery {
  if (!isPlainObject(raw)) fail("expected a JSON object")
  checkKeys(
    raw,
    [
      "table",
      "select",
      "where",
      "whereAny",
      "aggregate",
      "groupBy",
      "having",
      "orderBy",
      "limit",
    ],
    "query"
  )

  const table = raw.table
  // Object.hasOwn keeps Object.prototype members ("toString", "__proto__"
  // etc.) out of the whitelist — a plain `queryTables[table]` truthiness
  // check accepts inherited functions and fails later with a raw
  // non-actionable SQLite error instead of "unknown table".
  if (typeof table !== "string" || !Object.hasOwn(queryTables, table)) {
    fail(
      `unknown table ${JSON.stringify(table)} (available: ${Object.keys(queryTables).join(", ")})`
    )
  }
  const def = queryTables[table]

  // ── select ────────────────────────────────────────────────────────────
  let select: string[] | null = null
  if (raw.select !== undefined) {
    if (!Array.isArray(raw.select))
      fail("select must be an array of column refs")
    if (raw.select.length === 0 || raw.select.length > MAX_SELECT) {
      fail(`select needs 1..${MAX_SELECT} column refs`)
    }
    const seen = new Set<string>()
    select = []
    for (const ref of raw.select) {
      checkRef(def, table, ref)
      const key = outputKey(ref)
      if (seen.has(key)) {
        fail(
          `duplicate output column '${key}' — select must resolve to unique result columns`
        )
      }
      seen.add(key)
      select.push(ref)
    }
  }

  // ── aggregates (aliases needed by groupBy/having/orderBy checks) ─────
  const aggregate: QueryAggregate[] = []
  /** alias → value kind (a text alias is sortable, but not havable) */
  const aliasKinds = new Map<string, "text" | "integer">()
  if (raw.aggregate !== undefined) {
    if (!Array.isArray(raw.aggregate)) fail("aggregate must be an array")
    if (raw.aggregate.length > MAX_AGGREGATES) {
      fail(`aggregate accepts at most ${MAX_AGGREGATES} entries`)
    }
    for (const item of raw.aggregate) {
      if (!isPlainObject(item)) fail("aggregate entries must be objects")
      checkKeys(item, ["fn", "column", "alias"], "aggregate entry")
      const fn = item.fn
      if (
        typeof fn !== "string" ||
        !(QUERY_AGGREGATE_FNS as readonly string[]).includes(fn)
      ) {
        fail(`aggregate.fn must be one of: ${QUERY_AGGREGATE_FNS.join(", ")}`)
      }
      const aggFn = fn as QueryAggregateFn
      let column: string | undefined
      if (item.column !== undefined) {
        column = checkRef(def, table, item.column)
      } else if (aggFn !== "count") {
        // the compiler builds sum/avg/min/max strictly from a resolved
        // column — only count(*) has a columnless form
        fail(
          `aggregate.fn '${aggFn}' requires a column (only 'count' may omit it)`
        )
      }
      // sum/avg on a text column silently yields garbage (SQLite coerces
      // non-numeric text to 0) instead of an error — restrict them to
      // integer columns, matching the filter-value type checks. min/max
      // stay valid on text (lexicographic min/max).
      if (
        column !== undefined &&
        (aggFn === "sum" || aggFn === "avg") &&
        columnKind(def, column) !== "integer"
      ) {
        fail(
          `aggregate.fn '${aggFn}' needs an integer column ('${column}' is text — min/max work on text)`
        )
      }
      if (item.alias !== undefined) {
        if (typeof item.alias !== "string" || !ALIAS_RE.test(item.alias)) {
          fail(
            "aggregate.alias must match [a-zA-Z][a-zA-Z0-9_]* (max 40 chars)"
          )
        }
      }
      const alias: string =
        item.alias === undefined
          ? aggregateAlias(aggFn, column)
          : (item.alias as string)
      if (aliasKinds.has(alias)) {
        fail(`duplicate aggregate alias '${alias}'`)
      }
      // min/max inherit the column kind (count/sum/avg are always numeric).
      // A text alias is valid in orderBy (lexicographic) but not having —
      // SQLite compares any text greater than any number, so a having op
      // on a text alias would silently filter everything one way.
      let aliasKind: "text" | "integer" = "integer"
      if (
        (aggFn === "min" || aggFn === "max") &&
        column !== undefined &&
        columnKind(def, column) === "text"
      ) {
        aliasKind = "text"
      }
      aliasKinds.set(alias, aliasKind)
      aggregate.push({
        fn: aggFn,
        column,
        alias,
      })
    }
  }

  // ── groupBy ───────────────────────────────────────────────────────────
  const groupBy: string[] = []
  if (raw.groupBy !== undefined) {
    if (!Array.isArray(raw.groupBy))
      fail("groupBy must be an array of column refs")
    if (raw.groupBy.length === 0 || raw.groupBy.length > MAX_GROUP_BY) {
      fail(`groupBy needs 1..${MAX_GROUP_BY} column refs`)
    }
    const seen = new Set<string>()
    for (const ref of raw.groupBy) {
      checkRef(def, table, ref)
      // dedupe on the compiled output key (base ref → itself, joined
      // "alias.col" → "alias_col"): two distinct refs can resolve to the
      // same SELECT label, which would collapse two GROUP BY expressions
      // into one lost row-object column (e.g. account_id + account.id).
      const key = outputKey(ref)
      if (seen.has(key)) fail(`duplicate groupBy output column '${key}'`)
      seen.add(key)
      groupBy.push(ref)
    }
  }

  // ── aggregate/groupBy consistency ─────────────────────────────────────
  // groupBy without aggregate has undefined semantics (SQLite bare-column
  // grouping picks arbitrary row values) and a limit cut on it could not
  // report a meaningful totalMatching group count — reject it.
  if (groupBy.length > 0 && aggregate.length === 0) {
    fail("groupBy requires at least one aggregate entry")
  }
  // Output keys of groupBy refs (outputKey: base ref → itself, joined
  // "alias.col" → "alias_col") must not collide with aggregate aliases —
  // the SELECT would emit the same label twice.
  for (const alias of aliasKinds.keys()) {
    if (groupBy.some((ref) => outputKey(ref) === alias)) {
      fail(
        `aggregate alias '${alias}' collides with a groupBy column name — choose a different alias`
      )
    }
  }
  // Aggregate queries output the groupBy columns plus the aggregate
  // aliases — the compiler never reads select in aggregate mode, so
  // accepting it would validate a restriction the result never applies.
  // Reject it up front: the model gets one clear, actionable message for
  // both shapes instead of a half-respected subset.
  if (aggregate.length > 0 && select) {
    fail(
      "select cannot be combined with aggregate — the result already contains the groupBy columns plus the aggregate aliases"
    )
  }

  // ── having (aggregate aliases only) ───────────────────────────────────
  let having: QueryCondition[] = []
  if (raw.having !== undefined) {
    if (aggregate.length === 0) {
      fail("having requires an aggregate entry")
    }
    if (!Array.isArray(raw.having))
      fail("having must be an array of conditions")
    if (raw.having.length > MAX_CONDITIONS) {
      fail(`having accepts at most ${MAX_CONDITIONS} conditions`)
    }
    having = raw.having.map((item, i) => {
      if (!isPlainObject(item)) fail(`having[${i}] must be an object`)
      checkKeys(item, ["column", "op", "value"], `having[${i}]`)
      const column = item.column
      if (typeof column !== "string" || !aliasKinds.has(column)) {
        fail(
          `having[${i}].column must be an aggregate alias (available: ${[...aliasKinds.keys()].join(", ")})`
        )
      }
      if (aliasKinds.get(column) === "text") {
        // SQLite orders any text greater than any number: a having op on
        // a text alias (min/max of a text column) would silently match or
        // reject every group — numeric comparisons only, fail here.
        fail(
          `having[${i}].column '${column}' is a text aggregate — having supports numeric comparisons only`
        )
      }
      const op = item.op
      if (typeof op !== "string") fail(`having[${i}].op must be a string`)
      if (!["eq", "ne", "gt", "gte", "lt", "lte"].includes(op)) {
        fail(`having[${i}].op must be one of: eq, ne, gt, gte, lt, lte`)
      }
      if (typeof item.value !== "number" || !Number.isFinite(item.value)) {
        fail(`having[${i}].value must be a number`)
      }
      return { column, op: op as QueryOp, value: item.value }
    })
  }

  // ── orderBy (column refs or aggregate aliases) ────────────────────────
  const orderBy: QueryOrder[] = []
  if (raw.orderBy !== undefined) {
    if (!Array.isArray(raw.orderBy)) fail("orderBy must be an array")
    if (raw.orderBy.length > MAX_ORDER_BY) {
      fail(`orderBy accepts at most ${MAX_ORDER_BY} entries`)
    }
    raw.orderBy.forEach((item, i) => {
      if (!isPlainObject(item)) fail(`orderBy[${i}] must be an object`)
      checkKeys(item, ["column", "direction"], `orderBy[${i}]`)
      const column = item.column
      if (typeof column !== "string" || column.length === 0) {
        fail(`orderBy[${i}].column must be a non-empty string`)
      }
      const direction = item.direction === undefined ? "asc" : item.direction
      if (direction !== "asc" && direction !== "desc") {
        fail(`orderBy[${i}].direction must be 'asc' or 'desc'`)
      }
      // alias refs are valid in aggregate queries; plain refs validated
      const isAlias = aliasKinds.has(column)
      if (!isAlias) {
        // a bare ref that looks like an alias but isn't must fail loudly
        checkRef(def, table, column)
        // SQLite would silently pick an arbitrary row value for a bare
        // ORDER BY column not in GROUP BY — same reasoning as the select
        // ⊆ groupBy rule above, fail loudly instead. The match stays a
        // literal string compare on purpose: differently-spelled
        // equivalents (category_id vs category.id) are NOT the same
        // expression here — the user-scoped LEFT JOIN nulls a dangling FK
        // ref — so "equivalent" refs must be spelled the same way to be
        // accepted.
        if (aggregate.length > 0 && !groupBy.includes(column)) {
          fail(
            `orderBy column '${column}' must appear in groupBy when aggregating`
          )
        }
      }
      orderBy.push({ column, direction })
    })
  }

  // ── limit ─────────────────────────────────────────────────────────────
  const rawLimit = raw.limit
  if (
    rawLimit !== undefined &&
    !(
      typeof rawLimit === "number" &&
      Number.isInteger(rawLimit) &&
      rawLimit >= 1
    )
  ) {
    fail("limit must be an integer >= 1")
  }
  const limit = Math.min(rawLimit ?? QUERY_DEFAULT_LIMIT, QUERY_MAX_ROWS)

  return {
    table,
    select,
    where: parseConditions(raw.where, def, table, "where"),
    whereAny: parseConditions(raw.whereAny, def, table, "whereAny"),
    aggregate,
    groupBy,
    having,
    orderBy,
    limit,
  }
}
