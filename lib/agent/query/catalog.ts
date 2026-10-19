import { eq, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import {
  accounts,
  categories,
  importBatches,
  labelRules,
  transactions,
} from "@/lib/db/schema"

/**
 * The query DSL catalog (ADR-0034): the single whitelist that decides
 * what `query_data` may touch. Everything the model can name — tables,
 * columns, join aliases — must be an entry here; the parser and compiler
 * both look up references in this map and fail closed on anything else.
 * Raw SQL never enters the picture: identifiers render from catalog
 * constants, values from model JSON become bound parameters, and the
 * `user_id` column is deliberately ABSENT from the addressable columns —
 * it is compiled into every query (and every join) from ToolContext.uid
 * instead, so per-user isolation cannot be bypassed by any query the
 * model produces.
 *
 * Derived columns (e.g. booking_month) carry an ``sql`` expression
 * instead of a table column; they behave like any other column in
 * select/filter/sort/group — that is what makes "Summe pro Monat"
 * answerable without any expression language in the DSL.
 */

/** Value kind of one column — drives the parser's type checks. */
export type QueryColumnKind = "text" | "integer"

export interface QueryColumnDef {
  kind: QueryColumnKind
  /** drizzle column object, or a derived ``sql`` expression */
  expr: AnySQLiteColumn | SQL
  /** compact German annotation rendered into the system-prompt reference */
  note?: string
}

/**
 * One allowed join: alias → target table (by catalog name) + fixed ON
 * predicate. Join targets are scoped by their user_id at compile time
 * (AND-ed into the ON clause), so a join can never widen a result with
 * another user's rows.
 */
export interface QueryJoinDef {
  /** catalog name of the joined table (must be a queryTables entry) */
  target: string
  /** fixed FK predicate, e.g. eq(categories.id, transactions.categoryId) */
  on: SQL
}

export interface QueryTableDef {
  table: SQLiteTable
  /** compiled into every query's WHERE — never addressable by the DSL */
  userIdColumn: AnySQLiteColumn
  /** addressable columns keyed by DSL name (snake_case, as in the DB) */
  columns: Record<string, QueryColumnDef>
  /** allowed joins keyed by singular alias (e.g. "category") */
  joins: Record<string, QueryJoinDef>
}

function col(
  kind: QueryColumnKind,
  expr: AnySQLiteColumn,
  note?: string
): QueryColumnDef {
  return { kind, expr, note }
}

/** Derived column: an sql`` expression that acts like a text column. */
function derived(expr: SQL, note?: string): QueryColumnDef {
  return { kind: "text", expr, note }
}

/**
 * The exposed tables: all financial domain tables, deliberately NOT
 * `users` (no user identity belongs in model view) and NOT the chat_*
 * tables (agent infrastructure, not data the model should reason about).
 */
export const queryTables: Record<string, QueryTableDef> = {
  accounts: {
    table: accounts,
    userIdColumn: accounts.userId,
    columns: {
      id: col("integer", accounts.id),
      iban: col("text", accounts.iban),
      name: col("text", accounts.name),
      created_at: col("text", accounts.createdAt),
    },
    joins: {},
  },
  categories: {
    table: categories,
    userIdColumn: categories.userId,
    columns: {
      id: col("integer", categories.id),
      name: col("text", categories.name),
      name_key: col("text", categories.nameKey),
      language: col("text", categories.language),
      origin: col("text", categories.origin, "llm|manual"),
      usage_count: col("integer", categories.usageCount),
      color: col("text", categories.color),
      created_at: col("text", categories.createdAt),
    },
    joins: {},
  },
  label_rules: {
    table: labelRules,
    userIdColumn: labelRules.userId,
    columns: {
      id: col("integer", labelRules.id),
      label_id: col("integer", labelRules.labelId),
      payer: col("text", labelRules.payer),
      payee: col("text", labelRules.payee),
      counterparty_iban: col("text", labelRules.counterpartyIban),
      created_at: col("text", labelRules.createdAt),
      updated_at: col("text", labelRules.updatedAt),
    },
    joins: {
      label: {
        target: "categories",
        on: eq(categories.id, labelRules.labelId),
      },
    },
  },
  import_batches: {
    table: importBatches,
    userIdColumn: importBatches.userId,
    columns: {
      id: col("text", importBatches.id),
      file_name: col("text", importBatches.fileName),
      account_id: col("integer", importBatches.accountId),
      status: col(
        "text",
        importBatches.status,
        "parsing|importing|labeling|completed|failed"
      ),
      error: col("text", importBatches.error),
      snapshot_date: col("text", importBatches.snapshotDate),
      snapshot_amount_cents: col(
        "integer",
        importBatches.snapshotAmountCents,
        "Cent"
      ),
      rows_total: col("integer", importBatches.rowsTotal),
      rows_imported: col("integer", importBatches.rowsImported),
      rows_duplicate: col("integer", importBatches.rowsDuplicate),
      rows_updated: col("integer", importBatches.rowsUpdated),
      labels_total: col("integer", importBatches.labelsTotal),
      labels_done: col("integer", importBatches.labelsDone),
      labels_failed: col("integer", importBatches.labelsFailed),
      created_at: col("text", importBatches.createdAt),
      updated_at: col("text", importBatches.updatedAt),
      completed_at: col("text", importBatches.completedAt),
    },
    joins: {
      account: {
        target: "accounts",
        on: eq(accounts.id, importBatches.accountId),
      },
    },
  },
  transactions: {
    table: transactions,
    userIdColumn: transactions.userId,
    columns: {
      id: col("text", transactions.id),
      account_id: col("integer", transactions.accountId),
      batch_id: col("text", transactions.batchId),
      booking_date: col(
        "text",
        transactions.bookingDate,
        'ISO "JJJJ-MM-TT", Stringvergleiche ok'
      ),
      booking_month: derived(
        sql`substr(${transactions.bookingDate}, 1, 7)`,
        "abgeleitet, JJJJ-MM"
      ),
      booking_year: derived(
        sql`substr(${transactions.bookingDate}, 1, 4)`,
        "abgeleitet"
      ),
      value_date: col("text", transactions.valueDate),
      status: col("text", transactions.status, "Gebucht|Nicht gebucht"),
      payer: col("text", transactions.payer),
      payee: col("text", transactions.payee),
      purpose: col("text", transactions.purpose),
      type: col("text", transactions.type, "Ausgang|Eingang"),
      counterparty_iban: col("text", transactions.counterpartyIban),
      amount_cents: col(
        "integer",
        transactions.amountCents,
        "Cent, negativ=Ausgabe"
      ),
      creditor_id: col("text", transactions.creditorId),
      mandate_ref: col("text", transactions.mandateRef),
      customer_ref: col("text", transactions.customerRef),
      category_id: col("integer", transactions.categoryId),
      label_status: col(
        "text",
        transactions.labelStatus,
        "pending|labeled|failed"
      ),
      label_attempts: col("integer", transactions.labelAttempts),
      source_hash: col("text", transactions.sourceHash),
      occurrence_index: col("integer", transactions.occurrenceIndex),
      hash_version: col("integer", transactions.hashVersion),
      created_at: col("text", transactions.createdAt),
      updated_at: col("text", transactions.updatedAt),
    },
    joins: {
      category: {
        target: "categories",
        on: eq(categories.id, transactions.categoryId),
      },
      account: {
        target: "accounts",
        on: eq(accounts.id, transactions.accountId),
      },
      batch: {
        target: "import_batches",
        on: eq(importBatches.id, transactions.batchId),
      },
    },
  },
}
