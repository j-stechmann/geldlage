/**
 * Parsing of German-format bank amounts and dates.
 *
 * These functions are the correctness core of the app: every cent that shows
 * up in analytics flows through them. All rules were derived from real DKB
 * exports and verified against template.csv edge cases.
 */

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly value: string
  ) {
    super(message)
    this.name = "ParseError"
  }
}

const CURRENCY_AND_SPACE_CHARS = /[€\u00A0\u202F\u2007\u2009\s]/g

/**
 * Parse a German-format monetary amount into integer cents.
 *
 * Rules (ordered):
 *  (a) both '.' and ',' present  → dot is thousands separator, comma decimal
 *  (b) only ',' present          → comma is decimal separator
 *  (c) only '.' present          →
 *        - all dot-separated groups after the first are exactly 3 digits
 *          → thousands separator ("-1.074" → -107400)
 *        - exactly one dot with 1-2 trailing digits → decimal point
 *          ("-1.03" → -103)
 *        - otherwise → rejected (ambiguous, fail fast)
 *  (d) fraction is padded/truncated to 2 digits (more than 2 digits rejects:
 *      no real DKB export has sub-cent amounts, so that is a parse error)
 *
 * Sign: leading '-' or trailing '-' (some exports) → negative.
 * Currency symbols, NBSP, narrow NBSP and plain whitespace are stripped.
 */
export function parseGermanAmountToCents(input: string): number {
  let s = input.normalize("NFC").replace(CURRENCY_AND_SPACE_CHARS, "")
  if (s.length === 0) {
    throw new ParseError("empty amount", input)
  }

  let negative = false
  if (s.startsWith("-")) {
    negative = true
    s = s.slice(1)
  } else if (s.endsWith("-")) {
    negative = true
    s = s.slice(0, -1)
  }
  if (s.startsWith("+")) {
    s = s.slice(1)
  }
  if (s.length === 0) {
    throw new ParseError("amount has no digits", input)
  }

  const hasDot = s.includes(".")
  const hasComma = s.includes(",")

  let intPart: string
  let fracPart = ""

  if (hasDot && hasComma) {
    // (a) dot = thousands, comma = decimal. e.g. "1.234,56"
    if (!/^\d{1,3}(\.\d{3})*,\d{0,2}$/.test(s)) {
      throw new ParseError(`malformed amount "${s}"`, input)
    }
    const [i, f = ""] = s.split(",")
    intPart = i.replace(/\./g, "")
    fracPart = f
  } else if (hasComma) {
    // (b) comma decimal. e.g. "-0,85", "2.731,8" is handled here too
    // (dot before comma is always thousands)
    if (!/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(s)) {
      throw new ParseError(`malformed amount "${s}"`, input)
    }
    const [i, f] = s.split(",")
    intPart = i.replace(/\./g, "")
    fracPart = f
  } else if (hasDot) {
    // (c) only dot: disambiguate thousands vs decimal
    const groups = s.split(".")
    const allThousands = groups.slice(1).every((g) => /^\d{3}$/.test(g))
    if (allThousands && /^\d{1,3}(\.\d{3})+$/.test(s)) {
      // "-1.074" → thousands
      intPart = s.replace(/\./g, "")
    } else if (/^\d{1,3}\.\d{1,2}$/.test(s)) {
      // "-1.03" → decimal point (1-3 integer digits only)
      const [i, f] = s.split(".")
      intPart = i
      fracPart = f
    } else {
      throw new ParseError(`ambiguous amount "${s}"`, input)
    }
  } else {
    // plain integer
    if (!/^\d+$/.test(s)) {
      throw new ParseError(`malformed amount "${s}"`, input)
    }
    intPart = s
  }

  if (!/^\d+$/.test(intPart) || intPart.length === 0) {
    throw new ParseError(`malformed integer part "${intPart}"`, input)
  }

  const frac2 = (fracPart + "00").slice(0, 2)
  const cents = Number.parseInt(intPart, 10) * 100 + Number.parseInt(frac2)

  if (!Number.isSafeInteger(cents)) {
    throw new ParseError(`amount out of range "${s}"`, input)
  }
  if (cents === 0) return 0
  return negative ? -cents : cents
}

/**
 * UI display format: German amount with trailing " €", U+2212 minus for
 * negatives (DKB style), "—" placeholder for missing values. Built on
 * formatCentsAsGerman, so it inherits the safe-integer guard.
 */
export function euro(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—"
  const formatted = formatCentsAsGerman(cents)
  return formatted.startsWith("-")
    ? `−${formatted.slice(1)} €`
    : `${formatted} €`
}

/**
 * Format integer cents back into a German amount string.
 * Used by tests (round-trip property) and potentially the UI.
 */
export function formatCentsAsGerman(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new ParseError(`not a safe integer: ${cents}`, String(cents))
  }
  const negative = cents < 0
  const abs = Math.abs(cents)
  const int = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, "0")
  const intStr = int.toLocaleString("de-DE")
  return `${negative ? "-" : ""}${intStr},${frac}`
}

/**
 * Parse a booking date. Accepts DD.MM.YYYY and DD.MM.YY.
 * 2-digit years pivot at 80: 00–79 → 2000–2079, 80–99 → 1980–1999.
 */
export function parseGermanDateToIso(input: string): string {
  const s = input.trim()
  const m = /^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/.exec(s)
  if (!m) {
    throw new ParseError(`malformed date "${s}"`, input)
  }
  const day = Number.parseInt(m[1], 10)
  const month = Number.parseInt(m[2], 10)
  let year = Number.parseInt(m[3], 10)
  if (m[3].length === 2) {
    year = year < 80 ? 2000 + year : 1900 + year
  }
  if (month < 1 || month > 12) {
    throw new ParseError(`invalid month in "${s}"`, input)
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) {
    throw new ParseError(`invalid day in "${s}"`, input)
  }
  const iso =
    `${String(year).padStart(4, "0")}-` +
    `${String(month).padStart(2, "0")}-` +
    `${String(day).padStart(2, "0")}`
  return iso
}

/** Normalize whitespace (incl. newlines and NBSP) for hashing and payloads. */
export function normalizeWhitespace(input: string | null | undefined): string {
  if (!input) return ""
  return input
    .normalize("NFC")
    .replace(/[\s\u00A0\u202F]+/g, " ")
    .trim()
}
