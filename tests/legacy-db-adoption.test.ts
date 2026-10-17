import { describe, it, expect, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import {
  getDb,
  resetDefaultDbForTest,
  createTestDb,
  migrateSchema,
  type Db,
} from "@/lib/db"
import { resetConfigCache } from "@/lib/config"
import * as schema from "@/lib/db/schema"

let tmpDir: string | null = null
const tmpDirs: string[] = []
let db: Db | null = null

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
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

function rawConnection(filePath: string): Database.Database {
  return new Database(filePath)
}

afterAll(() => {
  db?.$client.close()
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs.length = 0
  tmpDir = null
})

describe("legacy dkb.db adoption (rebrand file rename)", () => {
  it("renames an existing dkb.db into the configured path with its data", () => {
    tmpDir = makeTmpDir("geldlage-legacy-adopt-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    const legacyPath = path.join(tmpDir, "dkb.db")

    const sqlite = new Database(legacyPath)
    sqlite.exec(`CREATE TABLE marker (v TEXT)`)
    sqlite.exec(`INSERT INTO marker VALUES ('kept')`)
    sqlite.close()

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(db.all(`SELECT v FROM marker`).length).toBe(1)
    })

    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.existsSync(dbPath)).toBe(true)
    const raw = rawConnection(dbPath)
    try {
      expect(raw.prepare(`SELECT v FROM marker`).get()).toEqual({ v: "kept" })
    } finally {
      raw.close()
    }
  })

  it("moves WAL sidecars along with the main file", () => {
    tmpDir = makeTmpDir("geldlage-legacy-wal-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    const legacyPath = path.join(tmpDir, "dkb.db")

    const sqlite = new Database(legacyPath)
    sqlite.pragma("journal_mode = WAL")
    sqlite.exec(`CREATE TABLE marker (v TEXT)`)
    sqlite.exec(`INSERT INTO marker VALUES ('wal')`)
    sqlite.close()
    // closing checkpoints and removes the sidecars; fake their presence
    for (const suffix of ["-wal", "-shm"]) {
      fs.writeFileSync(legacyPath + suffix, "x")
    }

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(db.all(`SELECT v FROM marker`).length).toBe(1)
      // while open: renamed sidecars exist (closing checkpoints/removes them)
      expect(fs.existsSync(legacyPath)).toBe(false)
      expect(fs.existsSync(legacyPath + "-wal")).toBe(false)
      expect(fs.existsSync(legacyPath + "-shm")).toBe(false)
      expect(fs.existsSync(dbPath + "-wal")).toBe(true)
      expect(fs.existsSync(dbPath + "-shm")).toBe(true)
    })
  })

  it("never overwrites an existing target DB", () => {
    tmpDir = makeTmpDir("geldlage-legacy-keep-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    const legacyPath = path.join(tmpDir, "dkb.db")

    const target = new Database(dbPath)
    target.exec(`CREATE TABLE marker (v TEXT)`)
    target.exec(`INSERT INTO marker VALUES ('target')`)
    target.close()
    const legacy = new Database(legacyPath)
    legacy.exec(`CREATE TABLE marker (v TEXT)`)
    legacy.exec(`INSERT INTO marker VALUES ('legacy')`)
    legacy.close()

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(db.all(`SELECT v FROM marker`)).toEqual([{ v: "target" }])
    })

    expect(fs.existsSync(legacyPath)).toBe(true)
  })

  it("does nothing when no legacy file exists", () => {
    tmpDir = makeTmpDir("geldlage-legacy-none-")
    const dbPath = path.join(tmpDir, "geldlage.db")

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(
        db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      ).toHaveLength(10) // 7 app tables + 3 agent chat tables (ADR-0033)
    })

    expect(fs.existsSync(dbPath)).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "dkb.db"))).toBe(false)
  })

  it("skips adoption for :memory: paths", () => {
    withFileDbPath(":memory:", () => {
      expect(() => {
        db = getDb()
      }).not.toThrow()
    })
  })
})

describe("legacy issuer migration (rebrand users.issuer rewrite)", () => {
  const LEGACY = "http://localhost:8081/application/o/dkb-analytics/"
  const TARGET = "http://localhost:8081/application/o/geldlage/"

  function withIssuers(fn: () => void) {
    const originals = {
      ISSUER: process.env.OIDC_ISSUER_URL,
      LEGACY: process.env.LEGACY_OIDC_ISSUER_URL,
    }
    process.env.OIDC_ISSUER_URL = TARGET
    process.env.LEGACY_OIDC_ISSUER_URL = LEGACY
    resetConfigCache()
    resetDefaultDbForTest()
    try {
      fn()
    } finally {
      process.env.OIDC_ISSUER_URL = originals.ISSUER
      process.env.LEGACY_OIDC_ISSUER_URL = originals.LEGACY
      resetConfigCache()
      resetDefaultDbForTest()
    }
  }

  it("migrates a legacy-issuer user with all of its data", () => {
    withIssuers(() => {
      db = getDb()
      const legacyId = db
        .insert(schema.users)
        .values({
          issuer: LEGACY,
          subject: "akadmin",
          name: "Old",
          email: "old@example.com",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get().id
      const accountId = db
        .insert(schema.accounts)
        .values({
          userId: legacyId,
          iban: "DE02120300000000202751",
          name: "Giropay",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get().id
      db.insert(schema.transactions)
        .values({
          id: "tx-1",
          userId: legacyId,
          accountId,
          bookingDate: "2026-01-01",
          type: "Ausgang",
          amountCents: -100,
          sourceHash: "h",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run()

      // next boot / hot reload re-runs migrateSchema on the same instance
      migrateSchema(db)

      const user = db.all<{ id: number; issuer: string; subject: string }>(
        `SELECT id, issuer, subject FROM users`
      )
      expect(user).toHaveLength(1)
      expect(user[0]).toEqual({
        id: legacyId,
        issuer: TARGET,
        subject: "akadmin",
      })
      expect(
        db.all(`SELECT id FROM transactions WHERE user_id = ${legacyId}`)
      ).toHaveLength(1)
    })
  })

  it("merges a JIT-created duplicate under the new issuer into the legacy user", () => {
    withIssuers(() => {
      db = getDb()
      const legacyId = db
        .insert(schema.users)
        .values({
          issuer: LEGACY,
          subject: "akadmin",
          name: "Old",
          email: "old@example.com",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get().id
      const dupId = db
        .insert(schema.users)
        .values({
          issuer: TARGET,
          subject: "akadmin",
          name: "Fresh",
          email: "fresh@example.com",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get().id
      const dupAccountId = db
        .insert(schema.accounts)
        .values({
          userId: dupId,
          iban: "DE02120300000000202051",
          name: "Neu",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get().id
      db.insert(schema.transactions)
        .values({
          id: "dup-tx",
          userId: dupId,
          accountId: dupAccountId,
          bookingDate: "2026-02-01",
          type: "Eingang",
          amountCents: 500,
          sourceHash: "d",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run()

      migrateSchema(db)

      expect(
        db.all<{ id: number; issuer: string }>(`SELECT id, issuer FROM users`)
      ).toEqual([{ id: legacyId, issuer: TARGET }])
      // duplicate's data re-pointed to the surviving (legacy) user
      expect(
        db.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM transactions WHERE user_id = ${legacyId}`
        )[0]?.n
      ).toBe(1)
      expect(
        db.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM accounts WHERE user_id = ${legacyId}`
        )[0]?.n
      ).toBe(1)
    })
  })

  it("no-ops when nothing matches the legacy issuer", () => {
    withIssuers(() => {
      db = getDb()
      db.insert(schema.users)
        .values({
          issuer: TARGET,
          subject: "someone",
          name: "S",
          email: "s@example.com",
          createdAt: new Date().toISOString(),
        })
        .run()
      migrateSchema(db)
      expect(db.all<{ issuer: string }>(`SELECT issuer FROM users`)).toEqual([
        { issuer: TARGET },
      ])
    })
  })

  it("skips the rewrite when multiple distinct issuers are present", () => {
    withIssuers(() => {
      db = getDb()
      db.insert(schema.users)
        .values({
          issuer: LEGACY,
          subject: "akadmin",
          name: "Old",
          email: "o@example.com",
          createdAt: new Date().toISOString(),
        })
        .run()
      db.insert(schema.users)
        .values({
          issuer: "https://other.example.com",
          subject: "other",
          name: "Other",
          email: "o2@example.com",
          createdAt: new Date().toISOString(),
        })
        .run()
      migrateSchema(db)
      const issuers = db
        .all<{ issuer: string }>(`SELECT issuer FROM users`)
        .map((u) => u.issuer)
      expect(issuers).toContain(LEGACY)
      expect(issuers).toContain("https://other.example.com")
    })
  })

  it("no-op when LEGACY_OIDC_ISSUER_URL is unset", () => {
    const original = process.env.LEGACY_OIDC_ISSUER_URL
    delete process.env.LEGACY_OIDC_ISSUER_URL
    resetConfigCache()
    try {
      db = createTestDb()
      db.insert(schema.users)
        .values({
          issuer: LEGACY,
          subject: "akadmin",
          name: "Old",
          email: "o@example.com",
          createdAt: new Date().toISOString(),
        })
        .run()
      // migrateSchema is exported and runs adoptLegacyIssuer; expect no change
      migrateSchema(db)
      expect(db.all<{ issuer: string }>(`SELECT issuer FROM users`)).toEqual([
        { issuer: LEGACY },
      ])
    } finally {
      if (original !== undefined) {
        process.env.LEGACY_OIDC_ISSUER_URL = original
      }
      resetConfigCache()
    }
  })
})
