import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import * as schema from "@/lib/db/schema"
import { getConfig } from "@/lib/config"
import { getDb, type Db } from "@/lib/db"

/**
 * Read-only database access for the query DSL (ADR-0034). The tool reads
 * through a SECOND better-sqlite3 handle opened with `readonly: true` —
 * belt and braces on top of the whitelist/compiler: even a future bug in
 * the query compiler cannot write, because the connection itself refuses
 * writes (SQLite file-level enforcement, `PRAGMA query_only` on top).
 *
 * WAL mode keeps this safe at runtime: readers never block the main
 * (write) singleton. The main handle is created first at boot (the app's
 * write path), so WAL/-shm exist and SQLite can complete recovery before
 * a read-only consumer ever opens — a cold read-only open of a hot WAL
 * would refuse otherwise.
 */

/**
 * Opens a strictly read-only connection to a file database. Exported for
 * tests (which verify the write refusal against a real file DB); the
 * runtime path goes through getReadOnlyDb().
 */
export function createReadOnlyDb(dbPath: string): Db {
  const sqlite = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  sqlite.pragma("busy_timeout = 5000")
  // File-level `readonly: true` already refuses writes; query_only also
  // blocks pragmas/mutations through any future code path that shares it.
  sqlite.pragma("query_only = ON")
  return drizzle(sqlite, { schema })
}

const globalRef = globalThis as unknown as {
  __geldlageReadOnlyDb?: Db
}

/**
 * The connection query_data reads through. Under vitest this is the
 * injected in-memory test DB (createTestDb/setTestDb seam — a file-based
 * readonly reopen cannot work against :memory:); production gets the
 * dedicated readonly file handle.
 */
export function getReadOnlyDb(): Db {
  if (process.env.VITEST) {
    return getDb()
  }
  if (!globalRef.__geldlageReadOnlyDb) {
    const dbPath = getConfig().DATABASE_PATH
    // :memory: (tooling/dev edge) has no file to reopen — fall back to the
    // main singleton rather than fail; the whitelist/compiler still guard it.
    globalRef.__geldlageReadOnlyDb = dbPath.includes(":memory:")
      ? getDb()
      : createReadOnlyDb(dbPath)
  }
  return globalRef.__geldlageReadOnlyDb
}
