import { NextRequest, NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, plannedTransactions } from "@/lib/db/schema"
import {
  normalizeCategoryKey,
  isValidLabelName,
  resetTransactionsForLabelDeletion,
} from "@/lib/labeller/service"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params
  const labelId = Number.parseInt(id, 10)
  if (!Number.isInteger(labelId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown
  } | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!isValidLabelName(name)) {
    return NextResponse.json(
      {
        error: "invalid_name",
        message:
          "name must be 1–64 UTF-8 bytes and free of | < > index= markers",
      },
      { status: 400 }
    )
  }

  const db = getDb()
  const userScope = and(
    eq(categories.id, labelId),
    eq(categories.userId, session.uid)
  )
  const current = db
    .select({ id: categories.id, nameKey: categories.nameKey })
    .from(categories)
    .where(userScope)
    .get()
  if (!current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const nameKey = normalizeCategoryKey(name)
  if (nameKey !== current.nameKey) {
    const clash = db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.userId, session.uid), eq(categories.nameKey, nameKey))
      )
      .get()
    if (clash) {
      return NextResponse.json(
        { error: "name_conflict", message: "label name already exists" },
        { status: 409 }
      )
    }
  }

  // renaming is user approval of the wording → flips origin to manual.
  // The pre-check above is advisory only: a concurrent rename/create onto
  // the same nameKey would violate the unique index and surface as a 500,
  // so the violation is caught and reported as 409 instead.
  try {
    db.update(categories)
      .set({ name, nameKey, origin: "manual" })
      .where(userScope)
      .run()
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return NextResponse.json(
        { error: "name_conflict", message: "label name already exists" },
        { status: 409 }
      )
    }
    throw err
  }

  return NextResponse.json({ id: labelId, name })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const { id } = await params
  const labelId = Number.parseInt(id, 10)
  if (!Number.isInteger(labelId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const db = getDb()
  const current = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, labelId), eq(categories.userId, session.uid)))
    .get()
  if (!current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  // 1. reset affected transactions so the worker re-labels them via the LLM
  //    (also re-points completed batches + refreshes labels_total)
  // 2. clear planned_transactions.category_id: plans carry the category FK
  //    too (no ON DELETE action); without this the delete would raise
  //    FOREIGN KEY constraint failed (unhandled → 500) whenever a plan
  //    references the label. Plans have no re-labeling concept — they keep
  //    expanding, just uncategorized ("ohne Kategorie"). Deliberately NOT
  //    user-scoped, unlike every other statement here: this is the FK safety
  //    net, not a data update — it must clear EVERY reference to this
  //    globally-unique id so the delete below can never fail, and a foreign
  //    plan referencing the category (unreachable through app writes, but
  //    visible to the FK) would otherwise re-raise the 500. Touches at most
  //    the one category id proven owned by the session user.
  // 3. delete: rules cascade (FK ON DELETE CASCADE), remaining category FKs
  //    satisfied by the resets above
  // All steps run in ONE transaction: a concurrent LLM apply landing between
  // the reset and the delete would otherwise hit the transactions.category_id
  // FK and 500. The reset sets labelAttempts to 0, invalidating any
  // in-flight claim, but the single commit removes that window entirely.
  const affectedIds = db.transaction((tx) => {
    const ids = resetTransactionsForLabelDeletion(labelId, tx)
    tx.update(plannedTransactions)
      .set({ categoryId: null })
      .where(eq(plannedTransactions.categoryId, labelId))
      .run()
    tx.delete(categories)
      .where(
        and(eq(categories.id, labelId), eq(categories.userId, session.uid))
      )
      .run()
    return ids
  })

  return NextResponse.json({ affected: affectedIds.length })
}
