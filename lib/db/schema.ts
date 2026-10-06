import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** OIDC issuer URL the identity was authenticated by */
    issuer: text("issuer").notNull(),
    /** OIDC subject claim (stable per issuer) */
    subject: text("subject").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [uniqueIndex("users_issuer_subject_unique").on(t.issuer, t.subject)]
)

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    iban: text("iban").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [uniqueIndex("accounts_user_iban_unique").on(t.userId, t.iban)]
)

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    fileName: text("file_name").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    accountId: integer("account_id").references(() => accounts.id),
    /** parsing | importing | labeling | completed | failed */
    status: text("status").notNull().default("parsing"),
    error: text("error"),
    snapshotDate: text("snapshot_date"),
    snapshotAmountCents: integer("snapshot_amount_cents"),
    rowsTotal: integer("rows_total").notNull().default(0),
    rowsImported: integer("rows_imported").notNull().default(0),
    rowsDuplicate: integer("rows_duplicate").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    labelsTotal: integer("labels_total").notNull().default(0),
    labelsDone: integer("labels_done").notNull().default(0),
    labelsFailed: integer("labels_failed").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    completedAt: text("completed_at"),
  },
  (t) => [index("import_batches_status_idx").on(t.status)]
)

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    language: text("language").notNull(),
    /** manual (user-created/renamed/assigned) | llm (invented by the model) */
    origin: text("origin").notNull().default("llm"),
    /** how often the label was applied/assigned (apply + assign events, not a live transaction count) */
    usageCount: integer("usage_count").notNull().default(0),
    /** permanent display color; unique across labels (NULL only as legacy/backfill fallback) */
    color: text("color"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex("categories_user_name_key_unique").on(t.userId, t.nameKey),
    uniqueIndex("categories_color_unique").on(t.color),
  ]
)

export const labelRules = sqliteTable(
  "label_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    labelId: integer("label_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    /** payer of the learned transactions (verbatim CSV value, never empty) */
    payer: text("payer").notNull(),
    /** payee of the learned transactions (verbatim CSV value, never empty) */
    payee: text("payee").notNull(),
    /** counterparty IBAN of the learned transactions (verbatim, never empty) */
    counterpartyIban: text("counterparty_iban").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex("label_rules_triple_unique").on(
      t.userId,
      t.payer,
      t.payee,
      t.counterpartyIban
    ),
    index("label_rules_label_idx").on(t.labelId),
    // Runtime enforcement comes from the hand-written DDL in lib/db/index.ts;
    // these check() defs only matter for drizzle-kit push and must stay in
    // sync with it.
    check("label_rules_payer_not_empty", sql`${t.payer} <> ''`),
    check("label_rules_payee_not_empty", sql`${t.payee} <> ''`),
    check(
      "label_rules_counterparty_iban_not_empty",
      sql`${t.counterpartyIban} <> ''`
    ),
  ]
)

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    batchId: text("batch_id").references(() => importBatches.id),
    bookingDate: text("booking_date").notNull(),
    valueDate: text("value_date"),
    status: text("status").notNull().default("Gebucht"),
    payer: text("payer"),
    payee: text("payee"),
    purpose: text("purpose"),
    type: text("type").notNull(),
    counterpartyIban: text("counterparty_iban"),
    amountCents: integer("amount_cents").notNull(),
    creditorId: text("creditor_id"),
    mandateRef: text("mandate_ref"),
    customerRef: text("customer_ref"),
    categoryId: integer("category_id").references(() => categories.id),
    /** pending | labeled | failed */
    labelStatus: text("label_status").notNull().default("pending"),
    labelAttempts: integer("label_attempts").notNull().default(0),
    sourceHash: text("source_hash").notNull(),
    occurrenceIndex: integer("occurrence_index").notNull().default(0),
    hashVersion: integer("hash_version").notNull().default(1),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex("transactions_dedupe_unique").on(
      t.accountId,
      t.sourceHash,
      t.occurrenceIndex
    ),
    index("transactions_user_booking_idx").on(t.userId, t.bookingDate),
    index("transactions_account_booking_idx").on(t.accountId, t.bookingDate),
    index("transactions_booking_date_idx").on(t.bookingDate),
    index("transactions_label_status_idx").on(t.labelStatus),
    index("transactions_batch_id_idx").on(t.batchId),
    index("transactions_category_idx").on(t.categoryId),
    index("transactions_payee_idx").on(t.payee),
  ]
)

export const chatThreads = sqliteTable(
  "chat_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Creator — the only role that can invite/rename/delete. */
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull().default("Neuer Chat"),
    /** Monotonic per-thread message counter for stable message ordering. */
    seq: integer("seq").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("chat_threads_user_updated_idx").on(t.userId, t.updatedAt)]
)

export const chatThreadMembers = sqliteTable(
  "chat_thread_members",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    /** invited (visible title-only) | joined (full read + participate) */
    state: text("state").notNull().default("invited"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.userId] }),
    index("chat_thread_members_user_idx").on(t.userId, t.state),
  ]
)

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** NULL = model-produced (assistant/tool); user messages carry the author */
    userId: integer("user_id").references(() => users.id),
    /** user | assistant | tool */
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** assistant: thinking trace (reasoning_content); kept out of loop input */
    reasoning: text("reasoning"),
    /** tool rows: registry name + raw JSON args (display + debugging) */
    toolName: text("tool_name"),
    toolArgs: text("tool_args"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** (thread seq, id-tiebreak) sort key for the message list */
    threadSeq: integer("thread_seq").notNull().default(0),
  },
  (t) => [
    index("chat_messages_thread_sort_idx").on(t.threadId, t.threadSeq, t.id),
    index("chat_messages_user_created_idx").on(t.userId, t.createdAt),
    // Runtime enforcement comes from the hand-written DDL in lib/db/index.ts
    // (role CHECK); these check() defs only matter for drizzle-kit push and
    // must stay in sync with it.
    check(
      "chat_messages_role_check",
      sql`${t.role} IN ('user', 'assistant', 'tool')`
    ),
  ]
)

export type ChatThread = typeof chatThreads.$inferSelect
export type ChatThreadMember = typeof chatThreadMembers.$inferSelect
export type ChatMessage = typeof chatMessages.$inferSelect
export type NewChatThread = typeof chatThreads.$inferInsert
export type NewChatThreadMember = typeof chatThreadMembers.$inferInsert
export type NewChatMessage = typeof chatMessages.$inferInsert

export type User = typeof users.$inferSelect
export type Account = typeof accounts.$inferSelect
export type ImportBatch = typeof importBatches.$inferSelect
export type Category = typeof categories.$inferSelect
export type LabelRule = typeof labelRules.$inferSelect
export type Transaction = typeof transactions.$inferSelect
export type NewTransaction = typeof transactions.$inferInsert
