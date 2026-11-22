import type { ParsedTransactionRow } from "@/lib/csv/parser"
import type { Transaction } from "@/lib/db/schema"
import { dayDiff } from "@/lib/dates"
import { greedyAssign } from "@/lib/greedy"

export const MATCH_WINDOW_DAYS = 7

const PENDING = "Nicht gebucht"
const BOOKED = "Gebucht"

/**
 * DB-side counterpart of an incoming ParsedTransactionRow: minimal generic
 * shape so pipeline and tests can construct candidates without the DB.
 */
export interface DbMatchRow {
  id: string
  bookingDate: string
  valueDate: string
  status: string
  payer: string | null
  payee: string | null
  purpose: string | null
  type: string
  counterpartyIban: string | null
  amountCents: number
  creditorId: string | null
  mandateRef: string | null
  customerRef: string | null
  sourceHash: string
  occurrenceIndex: number
}

export function toDbMatchRow(t: Transaction): DbMatchRow {
  return {
    id: t.id,
    bookingDate: t.bookingDate,
    valueDate: t.valueDate ?? "",
    status: t.status,
    payer: t.payer,
    payee: t.payee,
    purpose: t.purpose,
    type: t.type,
    counterpartyIban: t.counterpartyIban,
    amountCents: t.amountCents,
    creditorId: t.creditorId,
    mandateRef: t.mandateRef,
    customerRef: t.customerRef,
    sourceHash: t.sourceHash,
    occurrenceIndex: t.occurrenceIndex,
  }
}

interface Matchable {
  bookingDate: string
  type: string
  counterpartyIban: string | null
  amountCents: number
  creditorId: string | null
  mandateRef: string | null
}

/**
 * Party identity: equal non-empty counterpartyIban, OR equal non-empty
 * creditorId, OR equal non-empty mandateRef — if none of the three is set
 * on both sides there is no match.
 */
function partyMatches(a: Matchable, b: Matchable): boolean {
  if (a.counterpartyIban && b.counterpartyIban) {
    return a.counterpartyIban === b.counterpartyIban
  }
  if (a.creditorId && b.creditorId) {
    return a.creditorId === b.creditorId
  }
  if (a.mandateRef && b.mandateRef) {
    return a.mandateRef === b.mandateRef
  }
  return false
}

function viableMatch(a: Matchable, b: Matchable): boolean {
  if (a.type !== b.type) return false
  if (a.amountCents !== b.amountCents) return false
  if (!partyMatches(a, b)) return false
  // NaN (malformed date) must not pass as a candidate
  return dayDiff(a.bookingDate, b.bookingDate) <= MATCH_WINDOW_DAYS
}

function sameContent(db: DbMatchRow, inc: ParsedTransactionRow): boolean {
  return (
    db.bookingDate === inc.bookingDate &&
    db.valueDate === inc.valueDate &&
    db.status === inc.status &&
    (db.payer ?? "") === inc.payer &&
    (db.payee ?? "") === inc.payee &&
    (db.purpose ?? "") === inc.purpose &&
    db.type === inc.type &&
    (db.counterpartyIban ?? "") === inc.counterpartyIban &&
    db.amountCents === inc.amountCents &&
    (db.creditorId ?? "") === inc.creditorId &&
    (db.mandateRef ?? "") === inc.mandateRef &&
    (db.customerRef ?? "") === inc.customerRef
  )
}

/** Content equality between two DB rows (null-safe both sides). */
function sameDbContent(a: DbMatchRow, b: DbMatchRow): boolean {
  return (
    a.bookingDate === b.bookingDate &&
    a.valueDate === b.valueDate &&
    a.status === b.status &&
    (a.payer ?? "") === (b.payer ?? "") &&
    (a.payee ?? "") === (b.payee ?? "") &&
    (a.purpose ?? "") === (b.purpose ?? "") &&
    a.type === b.type &&
    (a.counterpartyIban ?? "") === (b.counterpartyIban ?? "") &&
    a.amountCents === b.amountCents &&
    (a.creditorId ?? "") === (b.creditorId ?? "") &&
    (a.mandateRef ?? "") === (b.mandateRef ?? "") &&
    (a.customerRef ?? "") === (b.customerRef ?? "")
  )
}

interface Candidate {
  kind: "upgrade" | "skip" | "refresh"
  rank: number
  leftKey: string
  rightKey: string
  diff: number
  dbBookingDate: string
}

/**
 * Smallest |date diff| first, then kind priority (upgrades before skips
 * before refreshes), then earliest DB bookingDate, then row ids/positions
 * for determinism. The consume-once loop is the shared greedy skeleton.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.diff - b.diff ||
    a.rank - b.rank ||
    a.dbBookingDate.localeCompare(b.dbBookingDate) ||
    a.leftKey.localeCompare(b.leftKey) ||
    a.rightKey.localeCompare(b.rightKey)
  )
}

const KIND_RANK: Record<Candidate["kind"], number> = {
  upgrade: 0,
  skip: 1,
  refresh: 2,
}

function buildCandidate(
  kind: Candidate["kind"],
  db: DbMatchRow,
  inc: ParsedTransactionRow,
  incIndex: number
): Candidate | null {
  if (!viableMatch(db, inc)) return null
  return {
    kind,
    rank: KIND_RANK[kind],
    leftKey: db.id,
    rightKey: String(incIndex),
    diff: dayDiff(db.bookingDate, inc.bookingDate),
    dbBookingDate: db.bookingDate,
  }
}

export interface FuzzyMatch {
  upgrades: Array<{ incomingIndex: number; dbId: string }>
  refreshes: Array<{ incomingIndex: number; dbId: string }>
  skips: Array<{ incomingIndex: number; dbId: string }>
}

/**
 * Bank-side identity for booked↔booked comparisons: DKB's Kundenreferenz
 * identifies a mandate/creditor relationship for recurring SEPA debits
 * (one generic reference per rent, insurance, …) but a per-transaction
 * reference for card charges. Same-date re-renders of one transaction (DKB
 * format changes) keep BOTH the Kundenreferenz and the Buchungstag, so
 * identity = ref + type + amount + exact booking date. Distinct monthly
 * debits never share a booking date and stay distinct.
 */
export function sameBankIdentity(
  a: Matchable & { customerRef: string | null },
  b: Matchable & { customerRef: string | null }
): boolean {
  return (
    !!a.customerRef &&
    !!b.customerRef &&
    a.customerRef === b.customerRef &&
    a.amountCents === b.amountCents &&
    a.type === b.type &&
    a.bookingDate === b.bookingDate
  )
}

/**
 * Classify incoming rows against the DB rows of one account:
 * - upgrade: incoming Gebucht ↔ DB Nicht gebucht (booked version arrived;
 *   DB pending row is updated in place)
 * - skip: incoming Nicht gebucht ↔ DB Gebucht (booked copy already stored;
 *   do not import)
 * - refresh: incoming Nicht gebucht ↔ DB Nicht gebucht with differing
 *   content (DB pending row is refreshed in place)
 * - skip: incoming Gebucht ↔ DB Gebucht with equal Kundenreferenz but
 *   differing content — DKB re-rendered the row between export formats
 *   (e.g. "EDEKA" vs "EDEKA.SCHROT/ELXLEBEN"); the transaction is already
 *   stored, so importing it again would double-count it.
 * Identical-content pairs (pending and booked) are deliberately absent:
 * the exact-dedupe tier already counts them as duplicates, so they are
 * not consumed here.
 */
export function matchIncoming(
  dbRows: DbMatchRow[],
  incoming: ParsedTransactionRow[]
): FuzzyMatch {
  const candidates: Candidate[] = []
  for (const db of dbRows) {
    for (let i = 0; i < incoming.length; i++) {
      const inc = incoming[i]
      if (db.status === PENDING) {
        if (inc.status === BOOKED) {
          const c = buildCandidate("upgrade", db, inc, i)
          if (c) candidates.push(c)
        } else if (inc.status === PENDING && !sameContent(db, inc)) {
          const c = buildCandidate("refresh", db, inc, i)
          if (c) candidates.push(c)
        }
      } else if (db.status === BOOKED && inc.status === PENDING) {
        const c = buildCandidate("skip", db, inc, i)
        if (c) candidates.push(c)
      } else if (db.status === BOOKED && inc.status === BOOKED) {
        // identical content is tier-1 territory; only re-rendered variants
        // (same bank identity, different content) land here as skips
        if (!sameContent(db, inc) && sameBankIdentity(db, inc)) {
          candidates.push({
            kind: "skip",
            rank: KIND_RANK.skip,
            leftKey: db.id,
            rightKey: String(i),
            diff: dayDiff(db.bookingDate, inc.bookingDate),
            dbBookingDate: db.bookingDate,
          })
        }
      }
    }
  }

  const result: FuzzyMatch = { upgrades: [], refreshes: [], skips: [] }
  for (const c of greedyAssign(candidates, compareCandidates)) {
    const entry = { incomingIndex: Number(c.rightKey), dbId: c.leftKey }
    if (c.kind === "upgrade") result.upgrades.push(entry)
    else if (c.kind === "skip") result.skips.push(entry)
    else result.refreshes.push(entry)
  }
  return result
}

/**
 * Self-heal: pending DB rows that fuzzy-match a booked row of the same
 * account are stale leftovers of earlier provisional imports → the pending
 * side becomes a delete candidate (the booked row stays).
 */
export function findDbSelfHealPairs(
  dbRows: DbMatchRow[]
): Array<{ pendingId: string; bookedId: string }> {
  const pending = dbRows.filter((r) => r.status === PENDING)
  const booked = dbRows.filter((r) => r.status === BOOKED)
  const candidates: Candidate[] = []
  for (const p of pending) {
    for (const b of booked) {
      if (!viableMatch(p, b)) continue
      candidates.push({
        kind: "upgrade",
        rank: 0,
        leftKey: p.id,
        rightKey: b.id,
        diff: dayDiff(p.bookingDate, b.bookingDate),
        dbBookingDate: p.bookingDate,
      })
    }
  }
  return greedyAssign(candidates, compareCandidates).map((c) => ({
    pendingId: c.leftKey,
    bookedId: c.rightKey,
  }))
}

/**
 * Self-heal for booked↔booked duplicates: rows sharing the same bank
 * identity (Kundenreferenz + exact booking date + amount + type) that
 * differ in content are re-renders of one transaction imported under two
 * DKB export formats. The strictly oldest member of an identity group is
 * the keeper; every newer member becomes a delete candidate. Equal/unknown
 * timestamps exclude a row from grouping (safe fallback). Identical-content
 * groups are tier-1 territory and are never returned here.
 */
export function findBookedSelfHealPairs(
  dbRows: DbMatchRow[],
  /** row id → createdAt (DB-only field, not part of DbMatchRow) */
  createdAtById: Map<string, string>
): Array<{ keepId: string; deleteId: string }> {
  const booked = dbRows.filter((r) => r.status === BOOKED)

  // group by bank identity (includes the exact booking date — recurring
  // SEPA debits reuse one generic Kundenreferenz per month and must NOT
  // collapse into one group)
  const groups = new Map<string, DbMatchRow[]>()
  for (const r of booked) {
    if (!r.customerRef) continue
    const key = `${r.customerRef}|${r.type}|${r.amountCents}|${r.bookingDate}`
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push(r)
  }

  const result: Array<{ keepId: string; deleteId: string }> = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    // order by createdAt; unknown timestamps ("") sort last and are
    // never keepers nor delete candidates (uncertain → no action)
    const withTime = group
      .map((r) => ({ row: r, createdAt: createdAtById.get(r.id) ?? null }))
      .filter((x) => x.createdAt !== null) as Array<{
      row: DbMatchRow
      createdAt: string
    }>
    if (withTime.length < 2) continue
    withTime.sort(
      (x, y) =>
        x.createdAt.localeCompare(y.createdAt) ||
        x.row.id.localeCompare(y.row.id)
    )
    const keep = withTime[0]
    for (let i = 1; i < withTime.length; i++) {
      const candidate = withTime[i]
      if (sameDbContent(keep.row, candidate.row)) {
        continue // true duplicate → tier-1/unique index territory
      }
      result.push({ keepId: keep.row.id, deleteId: candidate.row.id })
    }
  }
  // deterministic output order
  result.sort(
    (x, y) =>
      x.deleteId.localeCompare(y.deleteId) || x.keepId.localeCompare(y.keepId)
  )
  return result
}
