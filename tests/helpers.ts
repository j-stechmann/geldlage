import { NextRequest } from "next/server"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { accounts, transactions, users } from "@/lib/db/schema"
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session"

export const TEST_ISSUER = "https://issuer.example.com"
export const TEST_SUBJECT = "user-1"
export const TEST_SUBJECT_2 = "user-2"

export interface TestUser {
  id: number
  subject: string
}

/** Provision a user row; defaults to the primary test identity. */
export function seedUser(
  db: Db,
  subject: string = TEST_SUBJECT,
  issuer: string = TEST_ISSUER
): number {
  const user = db
    .insert(users)
    .values({
      issuer,
      subject,
      name: subject === TEST_SUBJECT ? "Test User" : subject,
      email: `${subject}@example.com`,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get()
  return user.id
}

/**
 * Standard per-test bootstrap: fresh in-memory DB (schema created), test seam
 * set, primary user provisioned. Returns { db, userId }.
 */
export function setupTestDb(): { db: Db; userId: number } {
  const db = createTestDb()
  setTestDb(db)
  const userId = seedUser(db)
  return { db, userId }
}

/**
 * Insert a booked transaction. Creates its own account (unique per tx id)
 * unless `accountId` is supplied; returns the account id used. Shared by the
 * date-contract, analytics and month-bound tests so their fixtures cannot
 * drift apart.
 */
export function seedBookedTransaction(
  db: Db,
  userId: number,
  id: string,
  bookingDate: string,
  opts: { accountId?: number; amountCents?: number } = {}
): number {
  const accountId =
    opts.accountId ??
    db
      .insert(accounts)
      .values({ userId, iban: `DE-${id}`, name: "Girokonto" })
      .returning()
      .get().id
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId,
      bookingDate,
      status: "Gebucht",
      type: "Eingang",
      amountCents: opts.amountCents ?? 100,
      sourceHash: `h-${id}`,
    })
    .run()
  return accountId
}

/**
 * A NextRequest carrying the signed session cookie for the given user id —
 * route handlers resolve the session from this header exactly like prod.
 */
export async function authedRequest(
  url: string,
  userId: number,
  init: { method?: string; body?: unknown; contentType?: string } = {}
): Promise<NextRequest> {
  const token = await createSessionToken({
    uid: userId,
    sub: TEST_SUBJECT,
    iss: TEST_ISSUER,
    name: "Test User",
    email: "user-1@example.com",
  })
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
  }
  if (init.body !== undefined) {
    headers["Content-Type"] = init.contentType ?? "application/json"
  }
  return new NextRequest(
    new Request(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
  )
}
