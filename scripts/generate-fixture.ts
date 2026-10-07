/**
 * Generates a deterministic synthetic DKB-style CSV fixture plus a
 * pre-computed KPI manifest. Used by the integration test to verify
 * analytics to the cent.
 *
 * Run: bun scripts/generate-fixture.ts [outdir]
 * Outputs: fixture.csv, fixture-manifest.json (analytics fixture)
 *          fixture-pending-resolved.csv,
 *          fixture-pending-resolved-manifest.json (reconcile fixture)
 *
 * The second export has the same account IBAN and reconciles against
 * fixture.csv: pending rows re-exported as booked, verbatim duplicates,
 * one identical pending copy and brand-new bookings.
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const HEADER =
  "Buchungsdatum;Wertstellung;Status;Zahlungspflichtige*r;Zahlungsempfänger*in;Verwendungszweck;Umsatztyp;IBAN;Betrag (€);Gläubiger-ID;Mandatsreferenz;Kundenreferenz"

function de(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const int = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, "0")
  const intStr = int.toLocaleString("de-DE")
  return `${neg ? "-" : ""}${intStr},${frac}`
}

function isoToDkb(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${d}.${m}.${y.slice(2)}`
}

interface RowSpec {
  date: string
  counterparty: string
  purpose: string
  type: "Ausgang" | "Eingang"
  amountCents: number
  status?: string
}

function row(r: RowSpec): string {
  const status = r.status ?? "Gebucht"
  const payer = r.type === "Eingang" ? r.counterparty : "Ich Selbst"
  const payee = r.type === "Ausgang" ? r.counterparty : "Ich Selbst"
  // quote fields containing delimiters, quotes or newlines (RFC 4180)
  const needsQuote = /[;"\n\r]/.test(r.purpose)
  const purpose = needsQuote ? `"${r.purpose.replace(/"/g, '""')}"` : r.purpose
  return [
    isoToDkb(r.date),
    isoToDkb(r.date),
    status,
    payer,
    payee,
    purpose,
    r.type,
    "DE02100100123456789001",
    de(r.amountCents),
    "",
    "",
    "",
  ].join(";")
}

// ── deterministic 24-month dataset: 2024-01 .. 2025-12 ────────────────
const rows: RowSpec[] = []
const months: string[] = []
for (let y = 2024; y <= 2025; y++) {
  for (let m = 1; m <= 12; m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`)
  }
}

const SNAP_DATE = "2024-01-05"
const SNAP_CENTS = 5_000_00 // 5.000,00 €

let seed = 42
function rand(max: number): number {
  // deterministic LCG (reserved for future randomized fixtures)
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % max
}
void rand

for (const month of months) {
  const y = Number.parseInt(month.slice(0, 4))
  const m = Number.parseInt(month.slice(5, 7))
  const day = (d: number) => `${month}-${String(d).padStart(2, "0")}`

  // salary on the 1st (exact)
  rows.push({
    date: day(1),
    counterparty: "Arbeitgeber GmbH",
    purpose: "Gehalt",
    type: "Eingang",
    amountCents: 3_500_00,
  })

  // rent on the 3rd (exact)
  rows.push({
    date: day(3),
    counterparty: "Vermieter GmbH",
    purpose: "Miete",
    type: "Ausgang",
    amountCents: -1_200_00,
  })

  // groceries: 4 varying purchases
  for (let i = 0; i < 4; i++) {
    const cents = -(2_000 + ((i * 7919 + m * 104729 + y) % 6_000))
    rows.push({
      date: day(5 + i * 5),
      counterparty: "Supermarkt",
      purpose: "Einkauf",
      type: "Ausgang",
      amountCents: cents,
    })
  }

  // identical same-day coffee pair (occurrence dedupe must keep both)
  rows.push({
    date: day(10),
    counterparty: "Cafe Mittelmeer",
    purpose: "Kaffee",
    type: "Ausgang",
    amountCents: -350,
  })
  rows.push({
    date: day(10),
    counterparty: "Cafe Mittelmeer",
    purpose: "Kaffee",
    type: "Ausgang",
    amountCents: -350,
  })

  // subscription with multi-line purpose (quoted CSV field)
  rows.push({
    date: day(15),
    counterparty: "Streaming AG",
    purpose: "SVWZ+Streaming\nAbonnement 01/2024",
    type: "Ausgang",
    amountCents: -1_299,
  })

  // one pending row per month (excluded from booked aggregates by default)
  rows.push({
    date: day(28),
    counterparty: "Pending Shop",
    purpose: "Noch nicht gebucht",
    type: "Ausgang",
    amountCents: -99,
    status: "Nicht gebucht",
  })

  // one zero-amount Eingang (must not distort averages)
  if (m % 3 === 0) {
    rows.push({
      date: day(20),
      counterparty: "Kreditkarte",
      purpose: "Saldoausgleich",
      type: "Eingang",
      amountCents: 0,
    })
  }
}

// one >512-char purpose in the last month (labeller truncation)
rows.push({
  date: "2025-12-20",
  counterparty: "Langtext GmbH",
  purpose: "X".repeat(600),
  type: "Ausgang",
  amountCents: -99_99,
})

// ── CSV assembly (with preamble like real DKB exports) ────────────────
const csvLines = [
  "Girokonto;DE02120300000000202051;",
  "Zeitraum:;01.01.2024 – 31.12.2025;",
  `Kontostand vom 05.01.2024:;${de(SNAP_CENTS)}\u00A0€;`,
  "",
  HEADER,
  ...rows.map(row),
]
const csv = "\uFEFF" + csvLines.join("\n") + "\n"

// ── manifest: hand-derived expectations, computed from the spec above ─
const booked = rows.filter((r) => (r.status ?? "Gebucht") === "Gebucht")

const monthly = months.map((month) => {
  const inMonth = booked.filter((r) => r.date.startsWith(month))
  const income = inMonth
    .filter((r) => r.amountCents > 0)
    .reduce((a, r) => a + r.amountCents, 0)
  const expenses = inMonth
    .filter((r) => r.amountCents < 0)
    .reduce((a, r) => a + -r.amountCents, 0)
  return { month, incomeCents: income, expensesCents: expenses }
})

const totalIncome = monthly.reduce((a, m) => a + m.incomeCents, 0)
const totalExpenses = monthly.reduce((a, m) => a + m.expensesCents, 0)
const monthsCounted = months.length // fixture data ends before "today" (2026)
const avgIncome = Math.round(totalIncome / monthsCounted)
const avgExpenses = Math.round(totalExpenses / monthsCounted)
const savingsRate = (avgIncome - avgExpenses) / avgIncome

// balance: latest snapshot = the only snapshot (2024-01-05, 5000 €)
const sumAfterSnapshot = booked
  .filter((r) => r.date > SNAP_DATE)
  .reduce((a, r) => a + r.amountCents, 0)
const currentBalance = SNAP_CENTS + sumAfterSnapshot

// top categories (expenses by counterparty label the labeller would give;
// the fixture manifest keys on counterparty since labeling is mocked)
const byCounterparty = new Map<string, number>()
for (const r of booked) {
  if (r.amountCents < 0) {
    byCounterparty.set(
      r.counterparty,
      (byCounterparty.get(r.counterparty) ?? 0) + -r.amountCents
    )
  }
}
const topCategories = [...byCounterparty.entries()]
  .map(([name, totalCents]) => ({ name, totalCents }))
  .sort((a, b) => b.totalCents - a.totalCents)

const manifest = {
  csvFileName: "fixture.csv",
  account: { iban: "DE02120300000000202051", name: "Girokonto" },
  snapshot: { date: SNAP_DATE, amountCents: SNAP_CENTS },
  rowCount: rows.length,
  pendingCount: rows.filter((r) => r.status === "Nicht gebucht").length,
  zeroAmountCount: rows.filter((r) => r.amountCents === 0).length,
  expected: {
    // analytics only over Status='Gebucht'
    transactionCount: booked.length,
    currentBalanceCents: currentBalance,
    avgMonthlyIncomeCents: avgIncome,
    avgMonthlyExpensesCents: avgExpenses,
    savingsRate,
    monthsCounted,
    monthlyCashflow: monthly,
    topCategories,
  },
}

const outDir = process.argv[2] ?? "tests/fixtures"
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, "fixture.csv"), csv, "utf8")
writeFileSync(
  join(outDir, "fixture-manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
)
console.log(
  `wrote ${outDir}/fixture.csv (${rows.length} rows) and fixture-manifest.json`
)

// ── second export: pending rows resolved + duplicates + new bookings ───
// Same account IBAN so it reconciles against fixture.csv's account.
// Layout chosen: exactly 24 booked "Pending Shop" rows — all 24 pending
// rows of fixture.csv re-exported as booked, where exactly ONE of them
// (2025-06) carries a changed purpose (upgrade-with-changed-content path).
// Plus: 10 booked rows copied verbatim from fixture.csv (exact-dedupe
// tier), 1 exact duplicate of a pending row ("Nicht gebucht", exercises
// the exact-duplicate tier for pending pairs — the fuzzy matcher never
// consumes equal-content pending pairs), and 5 brand-new bookings unique
// to this file. The 10 copied rows and the 24 upgrades are disjoint
// (pending rows are never among the copied ones), so upgrade counting
// stays unambiguous: upgrades = 24.

interface BookedRowSpec {
  date: string
  counterparty: string
  purpose: string
  type: "Ausgang" | "Eingang"
  amountCents: number
  status?: string
}

function shiftDay2(date: string): string {
  const y = Number.parseInt(date.slice(0, 4))
  const m = Number.parseInt(date.slice(5, 7))
  const d = Number.parseInt(date.slice(8, 10))
  // pending rows live on day 28; shift +2 days, clamped to the month end
  // (February 2025 has 28 days → clamp to 28, still inside the ±7 window)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const shifted = Math.min(d + 2, daysInMonth)
  return `${y}-${String(m).padStart(2, "0")}-${String(shifted).padStart(2, "0")}`
}

const pendingRows = rows.filter((r) => r.status === "Nicht gebucht")

// one pending row (2025-06) gets a changed purpose in its booked version
const CHANGED_PURPOSE_MONTH = "2025-06"
const CHANGED_PURPOSE_TEXT = "Pending Shop Bestellung 2025-06"

// booked versions of every pending row (same counterparty, amount and —
// except for the one changed-purpose row — same purpose text)
const upgradedSpecs: BookedRowSpec[] = pendingRows.map((p) => {
  const isChanged = p.date.startsWith(CHANGED_PURPOSE_MONTH)
  return {
    date: shiftDay2(p.date),
    counterparty: p.counterparty,
    purpose: isChanged ? CHANGED_PURPOSE_TEXT : p.purpose,
    type: p.type,
    amountCents: p.amountCents,
    status: "Gebucht",
  }
})

// 10 verbatim copies of already-booked rows from fixture.csv (indices
// within `rows`), a mix across counterparties, months and types. None of
// these is a pending row (pending rows only appear in upgradedSpecs) and
// none carries a quoted multi-line purpose, so "verbatim" is unambiguous.
const VERBATIM_INDICES = [0, 1, 5, 22, 47, 92, 130, 190, 247, 248]
const verbatimSpecs: BookedRowSpec[] = VERBATIM_INDICES.map((idx) => {
  const r = rows[idx]
  if (!r || (r.status ?? "Gebucht") !== "Gebucht") {
    throw new Error(
      `verbatim index ${idx} is not a booked row — fix VERBATIM_INDICES`
    )
  }
  return { ...r }
})

const duplicatePendingSpec: BookedRowSpec = {
  ...pendingRows[0],
  status: "Nicht gebucht",
}

const NEW_BOOKED_SPEC: BookedRowSpec[] = [
  {
    date: "2024-03-07",
    counterparty: "Resolved Shop",
    purpose: "Neue Buchung Maerz",
    type: "Ausgang",
    amountCents: -1_234,
  },
  {
    date: "2024-09-12",
    counterparty: "Resolved Shop",
    purpose: "Neue Buchung September",
    type: "Ausgang",
    amountCents: -5_678,
  },
  {
    date: "2025-02-17",
    counterparty: "Resolved Shop",
    purpose: "Neue Buchung Februar",
    type: "Ausgang",
    amountCents: -901,
  },
  {
    date: "2025-07-21",
    counterparty: "Resolved Shop",
    purpose: "Neue Buchung Juli",
    type: "Ausgang",
    amountCents: -12_345,
  },
  {
    date: "2025-11-11",
    counterparty: "Resolved Shop",
    purpose: "Gutschrift Resolved",
    type: "Eingang",
    amountCents: 3_456,
  },
]

// newest content date across both files drives the second balance snapshot
const latestContentDate = [...rows, ...NEW_BOOKED_SPEC]
  .map((r) => r.date)
  .sort()
  .at(-1)!
const RESOLVE_SNAP_DATE = `${latestContentDate.slice(0, 4)}-${latestContentDate.slice(5, 7)}-01`

// plausible closing balance: first snapshot grown by everything booked after
// it (upgrades keep the amounts of their pending originals, pending rows sit
// on day 28 → after the 5th, so summing the original rows is exact)
const pendingCents = pendingRows.reduce((a, r) => a + r.amountCents, 0)
const resolveSumAfterFirstSnap = booked
  .filter((r) => r.date > SNAP_DATE)
  .reduce((a, r) => a + r.amountCents, 0)
const newBookedSum = NEW_BOOKED_SPEC.reduce((a, r) => a + r.amountCents, 0)
const RESOLVE_SNAP_CENTS =
  SNAP_CENTS + resolveSumAfterFirstSnap + pendingCents + newBookedSum

const resolveRows: BookedRowSpec[] = [
  ...upgradedSpecs,
  ...verbatimSpecs,
  duplicatePendingSpec,
  ...NEW_BOOKED_SPEC,
]

const RESOLVE_IBAN = "DE02120300000000202051"

const resolveCsvLines = [
  `Girokonto;${RESOLVE_IBAN};`,
  "Zeitraum:;01.01.2024 – 31.12.2025;",
  `Kontostand vom ${RESOLVE_SNAP_DATE.split("-").reverse().join(".")}:;${de(RESOLVE_SNAP_CENTS)}\u00A0€;`,
  "",
  HEADER,
  ...resolveRows.map((r) =>
    row({
      date: r.date,
      counterparty: r.counterparty,
      purpose: r.purpose,
      type: r.type,
      amountCents: r.amountCents,
      status: r.status,
    })
  ),
]
const resolveCsv = "\uFEFF" + resolveCsvLines.join("\n") + "\n"

const pendingResolvedManifest = {
  csvFileName: "fixture-pending-resolved.csv",
  account: { iban: RESOLVE_IBAN, name: "Girokonto" },
  layout: {
    // chosen layout documented per spec: 24 booked "Pending Shop" rows
    // total — 23 with unchanged purpose + 1 with changed purpose — so
    // upgrades (= pending rows whose booked version arrived) = 24
    bookedPendingShopVersions: upgradedSpecs.length,
    purposeChangedCount: 1,
    purposeUnchangedCount: upgradedSpecs.length - 1,
    upgradeCount: pendingRows.length,
  },
  rowCount: resolveRows.length,
  expected: {
    // 24 pending→booked upgrades (one with changed content, still an upgrade)
    upgrades: upgradedSpecs.length,
    // verbatim booked copies handled by the exact-dedupe tier
    unchangedDuplicates: verbatimSpecs.length,
    newBookedCount: NEW_BOOKED_SPEC.length,
    // one "Nicht gebucht" verbatim copy of a pending row: the fuzzy matcher
    // never consumes equal-content pending pairs, the exact tier catches it
    duplicatePendingCopies: 1,
    insertedCount: NEW_BOOKED_SPEC.length,
    updatedCount: upgradedSpecs.length,
    skippedCount: 0,
    duplicateCount: verbatimSpecs.length + 1,
    totalTransactionsAfter: rows.length + NEW_BOOKED_SPEC.length,
  },
}

writeFileSync(join(outDir, "fixture-pending-resolved.csv"), resolveCsv, "utf8")
writeFileSync(
  join(outDir, "fixture-pending-resolved-manifest.json"),
  JSON.stringify(pendingResolvedManifest, null, 2),
  "utf8"
)
console.log(
  `wrote ${outDir}/fixture-pending-resolved.csv (${resolveRows.length} rows) and fixture-pending-resolved-manifest.json`
)
