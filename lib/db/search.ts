import { sql, type SQL, type SQLWrapper } from "drizzle-orm"

/**
 * Shared SQL text-search helpers.
 *
 * LIKE metacharacters are escaped explicitly: SQLite has no default escape
 * character, so the pattern must be matched with `ESCAPE '\'` (see
 * `likeEscaped`) — drizzle's `like()` cannot emit that clause. Without it a
 * `%`/`_` typed into the search acts as a wildcard and returns rows that do
 * not contain the query.
 *
 * Case folding: SQLite's `LIKE` folds ASCII only, so a German user searching
 * `überweisung` would not match a stored `Überweisung`. `search_fold` is a
 * connection-level function (registered by `createSchemaSqlite`, re-checked by
 * `getDb`/`getReadOnlyDb` for dev hot reloads) that
 * lowercases with JS's Unicode-aware `toLowerCase`; `likeEscapedFolded` folds
 * BOTH the column and the pattern. Folding costs a JS callback per scanned row
 * and column, so it is used where the scanned set is small by nature
 * (a user's plans); the transaction search keeps `likeEscaped` because it
 * scans the full booking history.
 */

/** SQL function name; registration and use must agree. */
export const SEARCH_FOLD_FN = "search_fold"

/** Fold a SQL text value; NULL / non-text stays NULL (LIKE then never matches). */
export function foldSearchText(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null
}

/**
 * Connection-level functions a given better-sqlite3 handle already has.
 * `registerSqlFunctions` is idempotent at the SQLite level, but getDb() runs
 * on every query; this keeps the re-registration cost to once per connection
 * (per module instance — a dev hot reload re-registers once, which is fine).
 */
const registeredSqlClients = new WeakSet<object>()

/**
 * Register the connection-level functions the query layer relies on. Called
 * from `createSchemaSqlite` (prod singleton, test DBs) and from `getDb` (dev
 * hot reloads, where the global holder outlives the module that first created
 * the handle) and `createReadOnlyDb` (the agent's second connection), so every
 * DB has them before any query runs. Registration is idempotent: SQLite
 * replaces a function of the same name/arity.
 */
export function registerSqlFunctions(sqlite: {
  function: (
    name: string,
    options: { deterministic: boolean },
    cb: (value: unknown) => string | null
  ) => unknown
}) {
  if (registeredSqlClients.has(sqlite)) return
  sqlite.function(SEARCH_FOLD_FN, { deterministic: true }, foldSearchText)
  registeredSqlClients.add(sqlite)
}

/** Escape LIKE metacharacters in user input for `ESCAPE '\'`. */
export function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1")
}

/**
 * `column LIKE ? ESCAPE '\'` — metacharacter-literal. Case-insensitivity is
 * whatever SQLite's LIKE provides (ASCII only).
 */
export function likeEscaped(column: SQLWrapper, pattern: string): SQL {
  // JS: "\\" → a single backslash in the generated SQL
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`
}

/**
 * `search_fold(column) LIKE search_fold(?) ESCAPE '\'` — metacharacter-literal
 * and case-insensitive beyond SQLite's ASCII-only LIKE (JS `toLowerCase`,
 * which covers German umlauts; it is not full Unicode case folding — `ß`/`SS`
 * still differ). Reserve this for small scanned sets: the fold is a JS call
 * per row and column.
 */
export function likeEscapedFolded(column: SQLWrapper, pattern: string): SQL {
  return sql`${sql.raw(SEARCH_FOLD_FN)}(${column}) LIKE ${sql.raw(SEARCH_FOLD_FN)}(${pattern}) ESCAPE '\\'`
}
