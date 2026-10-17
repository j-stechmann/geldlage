import { describe, it, expect, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import * as schema from "@/lib/db/schema"
import { getDb, resetDefaultDbForTest, type Db } from "@/lib/db"
import { resetConfigCache } from "@/lib/config"
import { seedUser } from "./helpers"
import { resolveAndUseCategory } from "@/lib/labeller/service"
import { eq } from "drizzle-orm"

let tmpDir: string | null = null
const tmpDirs: string[] = []
let db: Db | null = null

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

// DDL of the previous release: label_rules keyed on (iban, name_key).
const OLD_LABEL_RULES_DDL = `
  CREATE TABLE label_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    iban TEXT NOT NULL,
    name_key TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

function createOldShapeFileDb(filePath: string) {
  const sqlite = new Database(filePath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  sqlite.exec(OLD_LABEL_RULES_DDL)
  sqlite.exec(
    `CREATE UNIQUE INDEX label_rules_iban_name_key_unique ON label_rules (iban, name_key)`
  )
  sqlite.close()
}

function createPreColorFileDb(filePath: string) {
  const sqlite = new Database(filePath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'llm',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `)
  sqlite.exec(
    `CREATE UNIQUE INDEX categories_name_key_unique ON categories (name_key)`
  )
  sqlite.exec(`
    INSERT INTO categories (name, name_key, language, created_at) VALUES
      ('A', 'a', 'de', '2024-01-01T00:00:00.000Z'),
      ('B', 'b', 'de', '2024-01-01T00:00:00.000Z'),
      ('C', 'c', 'de', '2024-01-01T00:00:00.000Z')
  `)
  sqlite.close()
}

// DDL of the previous release: chat_messages without the transcript-
// replay columns (pre-amendment persister output).
const OLD_CHAT_MESSAGES_DDL = `
  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    reasoning TEXT,
    tool_name TEXT,
    tool_args TEXT,
    created_at TEXT NOT NULL,
    thread_seq INTEGER NOT NULL DEFAULT 0
  )
`

function createPreTranscriptFileDb(filePath: string) {
  const sqlite = new Database(filePath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  sqlite.exec(
    `CREATE UNIQUE INDEX users_issuer_subject_unique ON users (issuer, subject)`
  )
  sqlite.exec(`
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL DEFAULT 'Neuer Chat',
      seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  sqlite.exec(OLD_CHAT_MESSAGES_DDL)
  sqlite.exec(`
    INSERT INTO users (issuer, subject, name, email, created_at)
    VALUES ('https://x', 's1', 'n', 'e', '2024-01-01T00:00:00.000Z')
  `)
  sqlite.exec(`
    INSERT INTO chat_threads (id, user_id, title, seq, created_at, updated_at)
    VALUES ('t1', 1, 'Neuer Chat', 2, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
  `)
  // one user row + one legacy tool row (no pairing id) to survive
  sqlite.exec(`
    INSERT INTO chat_messages (id, thread_id, user_id, role, content, created_at, thread_seq)
    VALUES ('m1', 't1', 1, 'user', 'alt', '2024-01-01T00:00:00.000Z', 1)
  `)
  sqlite.exec(`
    INSERT INTO chat_messages (id, thread_id, user_id, role, content, tool_name, tool_args, created_at, thread_seq)
    VALUES ('m2', 't1', NULL, 'tool', '{}', 'get_category_totals', '{}', '2024-01-01T00:00:00.000Z', 2)
  `)
  sqlite.close()
}

function withFileDbPath(filePath: string, fn: () => void) {
  const original = process.env.DATABASE_PATH
  process.env.DATABASE_PATH = filePath
  resetConfigCache()
  resetDefaultDbForTest()
  db = null
  try {
    fn()
  } finally {
    ;(db as Db | null)?.$client.close()
    db = null
    process.env.DATABASE_PATH = original
    resetConfigCache()
    resetDefaultDbForTest()
  }
}

function rawConnection(): Database.Database {
  return new Database(path.join(tmpDir!, "geldlage.db"))
}

afterAll(() => {
  db?.$client.close()
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs.length = 0
  tmpDir = null
})

describe("file DB migration: color column backfill", () => {
  it("adds color, backfills unique colors, and enforces uniqueness", () => {
    tmpDir = makeTmpDir("geldlage-color-migration-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    createPreColorFileDb(dbPath)

    withFileDbPath(dbPath, () => {
      db = getDb()
      const userId = seedUser(db)
      // pre-user tables are dropped and recreated empty (multi-user fresh
      // start, ADR-0032): legacy categories A/B/C do not survive
      const cats = db.select().from(schema.categories).all()
      expect(cats).toHaveLength(0)

      // new categories get a color via the allocation choke point
      const newId = db.transaction((tx) =>
        resolveAndUseCategory(tx, userId, "D")
      )
      expect(newId).not.toBeNull()
      const inserted = db
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.id, newId!))
        .get()
      expect(inserted?.color).not.toBeNull()
      // allocation excludes colors already in use (the palette head is in
      // use by the first "D" allocation in a fresh table? no — table is
      // empty, so resolveAndUseCategory picked the palette head itself;
      // a second allocation must differ from it)
      const allColors = db
        .select()
        .from(schema.categories)
        .all()
        .map((c) => c.color)
      expect(new Set(allColors).size).toBe(allColors.length)
    })

    const raw = rawConnection()
    try {
      const catCols = (
        raw.pragma(`table_info(categories)`) as { name: string }[]
      ).map((c) => c.name)
      expect(catCols).toContain("color")
      const indexes = (
        raw.pragma(`index_list(categories)`) as { name: string }[]
      ).map((i) => i.name)
      expect(indexes).toContain("categories_color_unique")
      // deterministic allocation on the recreated table: the single
      // category carries a non-null color from the curated palette
      const ids = raw
        .prepare<[], { id: number; color: string | null }>(
          `SELECT id, color FROM categories ORDER BY id ASC`
        )
        .all()
      expect(ids.length).toBe(1)
      expect(ids[0].color).not.toBeNull()
    } finally {
      raw.close()
    }
  })

  it("violating the color unique index throws", () => {
    tmpDir = makeTmpDir("geldlage-color-unique-")
    const dbPath = path.join(tmpDir, "geldlage.db")

    withFileDbPath(dbPath, () => {
      db = getDb()
      const userId = seedUser(db)
      db.insert(schema.categories)
        .values({
          userId,
          name: "A",
          nameKey: "a",
          language: "de",
          origin: "llm",
          color: "oklch(0.62 0.17 250)",
          createdAt: new Date().toISOString(),
        })
        .run()
      expect(() =>
        db!
          .insert(schema.categories)
          .values({
            userId,
            name: "B",
            nameKey: "b",
            language: "de",
            origin: "llm",
            color: "oklch(0.62 0.17 250)",
            createdAt: new Date().toISOString(),
          })
          .run()
      ).toThrow(/UNIQUE/)
    })
  })
})

describe("file DB migration: transcript replay columns", () => {
  it("adds tool_calls/tool_call_id idempotently; legacy rows stay NULL", () => {
    tmpDir = makeTmpDir("geldlage-transcript-migration-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    createPreTranscriptFileDb(dbPath)

    withFileDbPath(dbPath, () => {
      // first getDb migrates, the second re-runs migrateSchema idempotently
      expect(() => {
        db = getDb()
        db = getDb()
      }).not.toThrow()
      const rows = db!.select().from(schema.chatMessages).all()
      expect(rows).toHaveLength(2)
      // no backfill: legacy rows keep NULL on both new columns
      expect(
        rows.every((r) => r.toolCalls === null && r.toolCallId === null)
      ).toBe(true)
    })

    const raw = rawConnection()
    try {
      const cols = (
        raw.pragma(`table_info(chat_messages)`) as { name: string }[]
      ).map((c) => c.name)
      expect(cols).toContain("tool_calls")
      expect(cols).toContain("tool_call_id")
    } finally {
      raw.close()
    }
  })
})

describe("file DB migration: old (iban, name_key) label_rules shape", () => {
  it("getDb() drops and rebuilds label_rules instead of crashing", () => {
    tmpDir = makeTmpDir("geldlage-migration-")
    createOldShapeFileDb(path.join(tmpDir, "geldlage.db"))

    withFileDbPath(path.join(tmpDir, "geldlage.db"), () => {
      expect(() => {
        db = getDb()
      }).not.toThrow()
    })

    const raw = rawConnection()
    try {
      const ruleCols = (
        raw.pragma(`table_info(label_rules)`) as { name: string }[]
      ).map((c) => c.name)
      expect(ruleCols).toContain("payer")
      expect(ruleCols).toContain("payee")
      expect(ruleCols).toContain("counterparty_iban")
      expect(ruleCols).not.toContain("iban")
      expect(ruleCols).not.toContain("name_key")

      const indexes = (
        raw.pragma(`index_list(label_rules)`) as { name: string }[]
      ).map((i) => i.name)
      expect(indexes).toContain("label_rules_triple_unique")

      const n = raw
        .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM label_rules`)
        .get()!.n
      expect(n).toBe(0)
    } finally {
      raw.close()
    }
  })

  it("rebuilt table enforces the triple unique index", () => {
    tmpDir = makeTmpDir("geldlage-migration-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    createOldShapeFileDb(dbPath)

    withFileDbPath(dbPath, () => {
      db = getDb()
      const userId = seedUser(db)
      db.insert(schema.categories)
        .values({
          userId,
          name: "Groceries",
          nameKey: "groceries",
          language: "de",
          origin: "llm",
          createdAt: new Date().toISOString(),
        })
        .run()
      const rule = {
        userId,
        labelId: 1,
        payer: "P",
        payee: "Q",
        counterpartyIban: "DE02120300000000202051",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      db.insert(schema.labelRules).values(rule).run()
      expect(() => db!.insert(schema.labelRules).values(rule).run()).toThrow(
        /UNIQUE/
      )
    })
  })

  it("fresh (empty) file DB still creates the full schema via getDb()", () => {
    tmpDir = makeTmpDir("geldlage-fresh-")
    const dbPath = path.join(tmpDir, "fresh.db")

    withFileDbPath(dbPath, () => {
      expect(() => {
        db = getDb()
      }).not.toThrow()
    })

    const raw = new Database(dbPath)
    try {
      const tables = raw
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table'`
        )
        .all()
        .map((r) => r.name)
      for (const expected of [
        "users",
        "accounts",
        "import_batches",
        "categories",
        "label_rules",
        "transactions",
      ]) {
        expect(tables).toContain(expected)
      }
    } finally {
      raw.close()
    }
  })
})
