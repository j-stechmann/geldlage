import { NextRequest, NextResponse } from "next/server"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import { isValidIsoDate, isoDatePlus } from "@/lib/planning/recurrence"
import { MAX_OCCURRENCE_WINDOW_DAYS } from "@/lib/planning/service"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Compact booked transactions for a calendar window — what the /planung
 * calendar renders as "real" chips beside the planned occurrences. Not
 * paginated (the window cap bounds it); booked rows only.
 */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams

  const from = sp.get("from")
  const to = sp.get("to")
  if (!from || !to || !isValidIsoDate(from) || !isValidIsoDate(to)) {
    return NextResponse.json(
      { error: "invalid_window", message: "from/to must be ISO dates" },
      { status: 400 }
    )
  }
  if (from > to) {
    return NextResponse.json(
      { error: "invalid_window", message: "from must not be after to" },
      { status: 400 }
    )
  }
  if (isoDatePlus(from, MAX_OCCURRENCE_WINDOW_DAYS) < to) {
    return NextResponse.json(
      {
        error: "window_too_large",
        message: `window must not exceed ${MAX_OCCURRENCE_WINDOW_DAYS} days`,
      },
      { status: 400 }
    )
  }
  const accountIdRaw = sp.get("accountId")
  let accountId: number | undefined
  if (accountIdRaw !== null) {
    const n = Number.parseInt(accountIdRaw, 10)
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: "invalid_account" }, { status: 400 })
    }
    accountId = n
  }

  const db = getDb()
  const conditions: SQL[] = [
    eq(transactions.userId, session.uid),
    // Gebucht AND Nicht gebucht: pending rows ("in flight" bank money) have
    // a Buchungsdatum too and belong on the calendar — distinguished by
    // `status`, the calendar renders them dashed/hollow
    inArray(transactions.status, ["Gebucht", "Nicht gebucht"]),
    sql`${transactions.bookingDate} >= ${from}`,
    sql`${transactions.bookingDate} <= ${to}`,
  ]
  if (accountId !== undefined) {
    conditions.push(eq(transactions.accountId, accountId))
  }
  const rows = db
    .select({
      id: transactions.id,
      date: transactions.bookingDate,
      status: transactions.status,
      type: transactions.type,
      payer: transactions.payer,
      payee: transactions.payee,
      purpose: transactions.purpose,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      accountId: transactions.accountId,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...conditions))
    .orderBy(transactions.bookingDate)
    .all()

  return NextResponse.json({
    transactions: rows.map((r) => ({
      id: r.id,
      date: r.date,
      status: r.status,
      // Vertragspartner semantics: outflows carry the payee, inflows the payer
      counterparty: r.type === "Ausgang" ? r.payee : r.payer,
      purpose: r.purpose,
      amountCents: r.amountCents,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      categoryColor: r.categoryColor,
      accountId: r.accountId,
    })),
  })
}
