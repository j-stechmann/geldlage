import Papa from "papaparse"
import {
  parseGermanAmountToCents,
  parseGermanDateToIso,
  normalizeWhitespace,
} from "@/lib/money"

export class CsvParseError extends Error {
  constructor(
    message: string,
    public readonly row?: number
  ) {
    super(message)
    this.name = "CsvParseError"
  }
}

export interface ParsedTransactionRow {
  bookingDate: string
  valueDate: string
  status: string
  payer: string
  payee: string
  purpose: string
  type: string
  counterpartyIban: string
  amountCents: number
  creditorId: string
  mandateRef: string
  customerRef: string
}

export interface ParsedCsv {
  accountName: string
  accountIban: string
  snapshotDate: string | null
  snapshotAmountCents: number | null
  rows: ParsedTransactionRow[]
}

export interface ParsedAccountInfo {
  accountName: string
  accountIban: string
  snapshotDate: string | null
  snapshotAmountCents: number | null
}

const EXPECTED_HEADERS = [
  "Buchungsdatum",
  "Wertstellung",
  "Status",
  "Zahlungspflichtige*r",
  "Zahlungsempfänger*in",
  "Verwendungszweck",
  "Umsatztyp",
  "IBAN",
  "Betrag (€)",
  "Gläubiger-ID",
  "Mandatsreferenz",
  "Kundenreferenz",
]

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

function cleanCell(v: string | undefined): string {
  return normalizeWhitespace(v ?? "")
}

/**
 * Extract account info from the preamble (before the header row).
 * Row 1: "Girokonto;DE02120300000000202051;..."
 * Row 3: "Kontostand vom 17.01.2026:;1.234,56 €"
 * Row 2 (Zeitraum) is intentionally ignored (unreliable format).
 */
function parsePreamble(rowsBeforeHeader: string[][]): ParsedAccountInfo {
  if (rowsBeforeHeader.length < 1) {
    throw new CsvParseError("missing preamble: no account row before header")
  }
  const accountRow = rowsBeforeHeader[0]
  const accountName = cleanCell(accountRow[0])
  const accountIban = cleanCell(accountRow[1]).toUpperCase()
  if (!accountName) {
    throw new CsvParseError("preamble row 1: missing account name")
  }
  if (!accountIban || !/^[A-Z]{2}[0-9A-Z]{10,30}$/.test(accountIban)) {
    throw new CsvParseError(
      `preamble row 1: invalid or missing account IBAN "${accountIban}"`
    )
  }

  let snapshotDate: string | null = null
  let snapshotAmountCents: number | null = null
  const saldoRow = rowsBeforeHeader.find((r) =>
    /^Kontostand vom/i.test(cleanCell(r[0]))
  )
  if (saldoRow) {
    const label = cleanCell(saldoRow[0])
    const dateMatch = /Kontostand vom (\d{2}\.\d{2}\.\d{4})/.exec(label)
    if (!dateMatch) {
      throw new CsvParseError(`cannot parse Kontostand date from "${label}"`)
    }
    snapshotDate = parseGermanDateToIso(dateMatch[1])
    const amountRaw = saldoRow[1] ?? ""
    if (!amountRaw.trim()) {
      throw new CsvParseError("Kontostand row has no amount")
    }
    snapshotAmountCents = parseGermanAmountToCents(amountRaw)
  }

  return { accountName, accountIban, snapshotDate, snapshotAmountCents }
}

/**
 * Parse a DKB CSV export. Fail-fast: the first unparseable data row aborts
 * the whole import (full retention makes lenient parsing unrecoverable).
 *
 * Column mapping is done BY HEADER NAME, not position, for robustness
 * against DKB format variations.
 */
export function parseDkbCsv(content: string): ParsedCsv {
  const cleaned = stripBom(content)

  const result = Papa.parse<string[]>(cleaned, {
    delimiter: ";",
    header: false,
    skipEmptyLines: "greedy",
  })
  if (result.errors.length > 0) {
    const first = result.errors[0]
    throw new CsvParseError(
      `CSV syntax error: ${first.message}`,
      (first.row ?? 0) + 1
    )
  }

  const rows = result.data as string[][]

  // Locate header row by exact cell match (never raw line search —
  // quoted preamble fields could contain the marker text).
  const headerIdx = rows.findIndex((row) =>
    row.some((cell) => cleanCell(cell) === "Buchungsdatum")
  )
  if (headerIdx === -1) {
    throw new CsvParseError(
      'header row not found: no cell equals "Buchungsdatum"'
    )
  }

  const header = rows[headerIdx].map(cleanCell)
  const col = new Map<string, number>()
  header.forEach((name, idx) => {
    if (name && !col.has(name)) col.set(name, idx)
  })
  for (const required of EXPECTED_HEADERS) {
    if (!col.has(required)) {
      throw new CsvParseError(`missing column "${required}" in header row`)
    }
  }

  const preamble = parsePreamble(rows.slice(0, headerIdx))

  const parsedRows: ParsedTransactionRow[] = []
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const raw = rows[i]
    // skip rows where every cell is empty (DKB pads with ;;;;)
    if (raw.every((c) => !c || !c.trim())) continue

    const get = (name: string) => {
      const idx = col.get(name)!
      return raw[idx] ?? ""
    }

    const type = cleanCell(get("Umsatztyp"))
    if (type !== "Ausgang" && type !== "Eingang") {
      throw new CsvParseError(
        `row ${i + 1}: invalid Umsatztyp "${type}" (expected Ausgang|Eingang)`
      )
    }

    let bookingDate: string
    let valueDate: string
    let amountCents: number
    try {
      bookingDate = parseGermanDateToIso(get("Buchungsdatum"))
      valueDate = parseGermanDateToIso(get("Wertstellung"))
    } catch (e) {
      throw new CsvParseError(`row ${i + 1}: ${(e as Error).message}`, i + 1)
    }
    try {
      amountCents = parseGermanAmountToCents(get("Betrag (€)"))
    } catch (e) {
      throw new CsvParseError(`row ${i + 1}: ${(e as Error).message}`, i + 1)
    }

    // Sign consistency: Umsatztyp must match amount sign.
    if (type === "Ausgang" && amountCents > 0) {
      throw new CsvParseError(
        `row ${i + 1}: Ausgang but amount is positive (${amountCents})`,
        i + 1
      )
    }
    if (type === "Eingang" && amountCents < 0) {
      throw new CsvParseError(
        `row ${i + 1}: Eingang but amount is negative (${amountCents})`,
        i + 1
      )
    }

    parsedRows.push({
      bookingDate,
      valueDate,
      status: cleanCell(get("Status")) || "Gebucht",
      payer: cleanCell(get("Zahlungspflichtige*r")),
      payee: cleanCell(get("Zahlungsempfänger*in")),
      purpose: normalizeWhitespace(get("Verwendungszweck")),
      type,
      counterpartyIban: cleanCell(get("IBAN")),
      amountCents,
      creditorId: cleanCell(get("Gläubiger-ID")),
      mandateRef: cleanCell(get("Mandatsreferenz")),
      customerRef: cleanCell(get("Kundenreferenz")),
    })
  }

  return { ...preamble, rows: parsedRows }
}

/**
 * Synchronous preamble-only scan for the POST /api/imports handler:
 * validates the file looks like a DKB export and returns account info
 * BEFORE any account/batch rows are created (no orphan rows on failure).
 */
export function peekDkbCsvAccount(content: string): ParsedAccountInfo {
  const cleaned = stripBom(content)
  const result = Papa.parse<string[]>(cleaned, {
    delimiter: ";",
    header: false,
    preview: 10,
  })
  if (result.errors.length > 0) {
    throw new CsvParseError(`CSV syntax error: ${result.errors[0].message}`)
  }
  const rows = result.data as string[][]
  const headerIdx = rows.findIndex((row) =>
    row.some((cell) => cleanCell(cell) === "Buchungsdatum")
  )
  if (headerIdx === -1) {
    throw new CsvParseError(
      "header row not found in first 10 rows: not a DKB export?"
    )
  }
  return parsePreamble(rows.slice(0, headerIdx))
}
