import { describe, it, expect } from "vitest"
import fc from "fast-check"
import {
  parseGermanAmountToCents,
  formatCentsAsGerman,
  parseGermanDateToIso,
  normalizeWhitespace,
  euro,
  ParseError,
} from "@/lib/money"

describe("parseGermanAmountToCents — disambiguation table", () => {
  const cases: Array<[string, number]> = [
    // comma decimal
    ["-0,85", -85],
    ["0,85", 85],
    ["-50", -5000],
    ["50", 5000],
    ["0", 0],
    ["-0", 0],
    ["0,00", 0],
    // comma decimal, 1 fractional digit
    ["2.731,8", 273180],
    ["3.010,2", 301020],
    ["2.676,43", 267643],
    ["-1.203,45", -120345],
    ["1.234,56", 123456],
    // dot thousands
    ["-1.074", -107400],
    ["1.074", 107400],
    ["1.234.567", 123456700],
    // dot decimal (2 fractional digits after single dot)
    ["-1.03", -103],
    ["1.77", 177],
    ["2.52", 252],
    ["-2.16", -216],
    ["0.5", 50],
    // currency / NBSP handling (Kontostand row: "1.234,56 €" with U+00A0)
    ["1.234,56\u00A0€", 123456],
    ["1.234,56 €", 123456],
    ["1.234,56\u202F€", 123456],
    ["\uFEFF-50", -5000],
    // trailing minus
    ["50-", -5000],
    // plus
    ["+2.731,8", 273180],
  ]

  it.each(cases)("parses %j → %j cents", (input, expected) => {
    expect(parseGermanAmountToCents(input)).toBe(expected)
  })
})

describe("parseGermanAmountToCents — rejections", () => {
  const invalid = [
    "",
    "   ",
    "€",
    "-",
    "abc",
    "12.345.6", // mixed grouping
    "1,2,3",
    "1,234", // comma with 3 fractional digits
    "1.234,567", // 3 fractional digits
    "1.2.3", // dot groups not all 3 digits
    "1234.56", // 4-digit int part with 2-digit fraction → ambiguous, rejected
    "--5",
    "5-5",
  ]

  it.each(invalid.map((v) => [v]))("rejects %j", (input) => {
    expect(() => parseGermanAmountToCents(input)).toThrow(ParseError)
  })
})

describe("parseGermanAmountToCents — round-trip property", () => {
  it("cents → German string → cents ≡ identity for all safe cent values", () => {
    const amountArb = fc.integer({
      min: -99_999_999_99,
      max: 99_999_999_99,
    })
    fc.assert(
      fc.property(amountArb, (cents) => {
        const str = formatCentsAsGerman(cents)
        expect(parseGermanAmountToCents(str)).toBe(cents)
      }),
      { numRuns: 10_000 }
    )
  })

  it("round-trips through explicitly constructed German strings", () => {
    // Non-formatted strings: German format with thousands dots, all ranges
    const intPart = fc.integer({ min: 0, max: 999_999_999 })
    const fracPart = fc.integer({ min: 0, max: 99 })
    fc.assert(
      fc.property(
        intPart,
        fracPart,
        fc.constantFrom("-", ""),
        (int, frac, sign) => {
          const magnitude = int * 100 + frac
          const cents = sign === "-" ? -magnitude : magnitude
          // "-0,00" is normalized to 0 by design (negative zero is not a
          // meaningful amount), so it cannot round-trip bit-identically
          const str =
            magnitude === 0
              ? "0"
              : `${sign}${int.toLocaleString("de-DE")},${String(frac).padStart(2, "0")}`
          expect(parseGermanAmountToCents(str)).toBe(cents === 0 ? 0 : cents)
        }
      ),
      { numRuns: 10_000 }
    )
  })
})

describe("parseGermanDateToIso", () => {
  const cases: Array<[string, string]> = [
    ["01.02.26", "2026-02-01"],
    ["31.12.99", "1999-12-31"],
    ["01.01.80", "1980-01-01"],
    ["17.01.2026", "2026-01-17"],
    ["01.03.2080", "2080-03-01"],
    ["29.02.24", "2024-02-29"], // leap year
  ]
  it.each(cases)("parses %j → %j", (input, expected) => {
    expect(parseGermanDateToIso(input)).toBe(expected)
  })

  const invalid = [
    "00.01.26",
    "32.01.26",
    "15.13.26",
    "15.00.26",
    "30.02.25", // not a leap year
    "1.2.26",
    "2026-01-01",
    "DD.MM.YY",
    "",
    "15.01",
  ]
  it.each(invalid.map((v) => [v]))("rejects %j", (input) => {
    expect(() => parseGermanDateToIso(input)).toThrow(ParseError)
  })
})

describe("euro", () => {
  it("formats amounts with a trailing euro sign and de-DE grouping", () => {
    expect(euro(123456)).toBe("1.234,56 €")
    expect(euro(0)).toBe("0,00 €")
    expect(euro(-7)).toBe("−0,07 €")
  })

  it("negatives use U+2212 (DKB style), not the ASCII hyphen", () => {
    const formatted = euro(-123456)
    expect(formatted).toBe("−1.234,56 €")
    expect(formatted.startsWith("-")).toBe(false)
    expect(formatted.startsWith("\u2212")).toBe(true)
  })

  it("renders an em-dash placeholder for missing values", () => {
    expect(euro(null)).toBe("—")
    expect(euro(undefined)).toBe("—")
  })
})

describe("normalizeWhitespace", () => {
  it("collapses whitespace, newlines and NBSP", () => {
    expect(normalizeWhitespace(" foo\u00A0 bar \n baz ")).toBe("foo bar baz")
    expect(normalizeWhitespace(null)).toBe("")
    expect(normalizeWhitespace(undefined)).toBe("")
  })
})
