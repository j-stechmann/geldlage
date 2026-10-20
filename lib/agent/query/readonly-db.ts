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
 * (write) singleton. getReadOnlyDb() materializes the main handle BEFORE
 * opening the readonly consumer (structural ordering, not an assumption
 * about app flow), so WAL recovery has completed and -wal/-shm exist.
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

/**
 * Opening a `:memory:` path readonly throws (better-sqlite3: "In-memory/
 * temporary databases cannot be readonly") — which is exactly right for a
 * path nothing in the repo or docs uses for a server run (operations.md
 * documents DATABASE_PATH as a WAL file; :memory: is only the vitest pin,
 * where the injected readonly connection below applies).
 */

const globalRef = globalThis as unknown as {
  __geldlageReadOnlyDb?: Db
  /** test-only: a real readonly connection injected by setReadOnlyTestDb */
  __geldlageReadOnlyTestDb?: Db
}

/**
 * The connection query_data reads through. Under vitest the query suite
 * injects a *real* readonly connection via setReadOnlyTestDb() (file-backed
 * test DB + createReadOnlyDb, so a compiler regression that emits a
 * mutating statement fails tests). An injected suite-less read never falls
 * back to the writable getDb() singleton — it throws instead: a silent
 * writable read would quietly void the write-refusal guarantee for that
 * suite. Production gets the dedicated readonly file handle.
 */
export function getReadOnlyDb(): Db {
  if (process.env.VITEST) {
    if (!globalRef.__geldlageReadOnlyTestDb) {
      throw new Error(
        "test setup: setReadOnlyTestDb(createReadOnlyDb(<file db>)) required before reading (a writable getDb() fallback would void the readonly guarantee)"
      )
    }
    return globalRef.__geldlageReadOnlyTestDb
  }
  if (!globalRef.__geldlageReadOnlyDb) {
    const dbPath = getConfig().DATABASE_PATH
    // getDb() FIRST, structurally (not by prior app flow): the write
    // singleton creates the file, sets WAL and completes recovery, so
    // the readonly open below never hits a cold WAL without -shm/-wal.
    // getDb() is memoized; this is a no-op when it already booted.
    getDb()
    globalRef.__geldlageReadOnlyDb = createReadOnlyDb(dbPath)
  }
  return globalRef.__geldlageReadOnlyDb
}

/**
 * For tests: inject a real readonly connection (createReadOnlyDb over a
 * file-backed test DB). Mirrors lib/db's setTestDb seam so getReadOnlyDb()
 * can be pointed at an actual write-refusing handle under vitest.
 */
export function setReadOnlyTestDb(db: Db | undefined): void {
  globalRef.__geldlageReadOnlyTestDb = db
}
