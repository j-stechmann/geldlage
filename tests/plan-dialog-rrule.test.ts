// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import {
  parseByMonthDay,
  parseRruleToForm,
  yearlyNoMonthHint,
} from "@/components/planning/plan-dialog"
import { describeRrule } from "@/components/planning/api"

const DTSTART = "2026-01-01"

/**
 * The plan dialog must keep the raw RRULE authoritative whenever its
 * builder fields cannot reproduce the stored rule 1:1. rawDirty=false means
 * "the rebuilt rule is semantically identical — the builder may own it";
 * rawDirty=true means "the raw text is kept, an untouched save would
 * otherwise silently rewrite the recurrence".
 *
 * Regression context: rawDirty used to be a hand-written allowlist that
 * missed several builder-unrenderable shapes — including one the builder
 * itself produces (YEARLY with 2+ month chips + weekday pattern) — so a
 * routine edit-save silently rewrote those plans' recurrences.
 */
describe("parseRruleToForm faithfulness gate", () => {
  it("keeps builder-renderable rules editable (rawDirty=false)", () => {
    for (const text of [
      "FREQ=DAILY",
      "FREQ=DAILY;INTERVAL=3",
      "FREQ=WEEKLY;BYDAY=MO,WE",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR",
      "FREQ=MONTHLY;BYMONTHDAY=1,15",
      "FREQ=MONTHLY;BYDAY=1FR",
      "FREQ=MONTHLY;BYDAY=-1FR",
      "FREQ=MONTHLY;BYDAY=5FR",
      "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1MO",
      "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
      "FREQ=YEARLY;BYMONTH=3;BYDAY=1FR",
    ]) {
      const o = parseRruleToForm(text, DTSTART)
      expect(o.rawDirty, text).toBe(false)
      expect(o.rawRrule, text).toBe(text)
    }
  })

  it("maps ordinal BYDAY into the builder's weekday-pattern fields", () => {
    // rrule's Weekday carries the ordinal as `n` — reading it wrong used to
    // make wday rules parse into empty "Am Tag des Monats" fields
    const o = parseRruleToForm("FREQ=MONTHLY;BYDAY=1FR", DTSTART)
    expect(o.rawDirty).toBe(false)
    expect(o.monthlyMode).toBe("wday")
    expect(o.ordinal).toBe("1")
    expect(o.ordinalDay).toBe("FR")
    const last = parseRruleToForm("FREQ=MONTHLY;BYDAY=-1FR", DTSTART)
    expect(last.ordinal).toBe("-1")
    expect(last.ordinalDay).toBe("FR")
    // 5th-weekday rules stay builder-renderable: the picker offers "5."
    const fifth = parseRruleToForm("FREQ=MONTHLY;BYDAY=5FR", DTSTART)
    expect(fifth.rawDirty).toBe(false)
    expect(fifth.ordinal).toBe("5")
    expect(fifth.ordinalDay).toBe("FR")
  })

  it("compares semantics, not spelling (explicit INTERVAL=1 stays editable)", () => {
    // canonical storage keeps an INTERVAL=1 the builder omits — equal
    // occurrence sets must still render as editable builder fields
    const o = parseRruleToForm("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", DTSTART)
    expect(o.rawDirty).toBe(false)
    expect(o.byDay).toEqual(["MO"])
  })

  it("keeps the raw text authoritative for shapes the builder can't render", () => {
    const cases = [
      // 2+ month chips + weekday pattern — buildable in the UI itself
      "FREQ=YEARLY;BYMONTH=3,6;BYDAY=1FR",
      // multi-ordinal BYDAY (raw field / API / agent)
      "FREQ=MONTHLY;BYDAY=1FR,-1FR",
      // ordinal beyond the picker (1–5, "letzte") — would render an empty
      // pattern select despite round-tripping the same rule
      "FREQ=MONTHLY;BYDAY=-2SU",
      // weekday-yearly without BYMONTH
      "FREQ=YEARLY;BYDAY=MO",
      // monthly plain-BYDAY + mday combos the builder can't express
      "FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=1",
    ]
    for (const text of cases) {
      const o = parseRruleToForm(text, DTSTART)
      expect(o.rawDirty, text).toBe(true)
      expect(o.rawRrule, text).toBe(text)
    }
  })

  it("uses an 800-day comparison window (two annual cycles)", () => {
    // first Monday of 2026 IS Jan 5 — a plain-yearly rule anchored there
    // coincides with "1MO yearly" through all of 2026 and must still not be
    // declared builder-renderable (2027 drifts: Jan 4 vs Jan 5)
    const o = parseRruleToForm("FREQ=YEARLY;BYDAY=1MO", "2026-01-05")
    expect(o.rawDirty).toBe(true)
    expect(o.rawRrule).toBe("FREQ=YEARLY;BYDAY=1MO")
  })

  it("bysetpos rules stay raw (unchanged behavior)", () => {
    const o = parseRruleToForm("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1", DTSTART)
    expect(o.rawDirty).toBe(true)
    expect(o.rawRrule).toBe("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1")
  })

  it("falls back to raw-authoritative without a usable dtstart", () => {
    expect(parseRruleToForm("FREQ=DAILY", undefined).rawDirty).toBe(true)
    expect(parseRruleToForm("FREQ=DAILY", null).rawDirty).toBe(true)
    expect(parseRruleToForm("FREQ=DAILY", "garbage").rawDirty).toBe(true)
  })

  it("one-offs and unparseable rules keep their existing mapping", () => {
    expect(parseRruleToForm(null)).toEqual({
      freq: "",
      rawRrule: "",
      rawDirty: false,
    })
    expect(parseRruleToForm("", DTSTART)).toEqual({
      freq: "",
      rawRrule: "",
      rawDirty: false,
    })
    expect(parseRruleToForm("nonsense", DTSTART).rawDirty).toBe(true)
  })
})

describe("parseRruleToForm part parity (sparse-rule hardening)", () => {
  // Probe-verified against the rrule engine: for both rules below, stored
  // AND mis-rebuilt rule expand to [] over the 800-day window — two equal
  // empty sets would wrongly read "faithful"; part parity is what keeps
  // the raw text authoritative.
  it("dropped BYDAY caught even when both window sets are empty", () => {
    // first occurrence 2100-02-26 (~100y out): the mis-rebuilt rule
    // (FREQ=YEARLY;INTERVAL=100;BYMONTH=2,3) silently drops BYDAY=-1FR
    const o = parseRruleToForm(
      "FREQ=YEARLY;INTERVAL=100;BYMONTH=2,3;BYDAY=-1FR",
      "2000-04-01"
    )
    expect(o.rawDirty).toBe(true)
    expect(o.rawRrule).toBe("FREQ=YEARLY;INTERVAL=100;BYMONTH=2,3;BYDAY=-1FR")
  })

  it("BYMONTH dropped on MONTHLY routes raw on the same empty-window trap", () => {
    // first occurrence 2036-02-01: the mis-rebuilt rule
    // (FREQ=MONTHLY;INTERVAL=120;BYMONTHDAY=1) silently drops BYMONTH=2
    const o = parseRruleToForm(
      "FREQ=MONTHLY;INTERVAL=120;BYMONTH=2;BYMONTHDAY=1",
      "2026-02-15"
    )
    expect(o.rawDirty).toBe(true)
    expect(o.rawRrule).toBe("FREQ=MONTHLY;INTERVAL=120;BYMONTH=2;BYMONTHDAY=1")
  })

  it("representable ultra-sparse rules stay builder-owned", () => {
    // leap-day on a century cadence (first occurrence 2400-02-29): both
    // window sets are empty AND every part round-trips — parity equal →
    // the builder may own the rule (untouched edit-save keeps the rule)
    const o = parseRruleToForm(
      "FREQ=YEARLY;INTERVAL=100;BYMONTH=2;BYMONTHDAY=29",
      "2000-03-01"
    )
    expect(o.rawDirty).toBe(false)
  })

  it("WKST does not demote semantics-free cases (interval 1 stays editable)", () => {
    // with interval 1, WKST cannot change any occurrence; the builder
    // drops it by design and that stays faithful — only INTERVAL ≥ 2
    // rules with a non-default WKST route raw
    expect(
      parseRruleToForm("FREQ=WEEKLY;BYDAY=MO;WKST=SU", DTSTART).rawDirty
    ).toBe(false)
  })
})

describe("parseByMonthDay token strictness", () => {
  it("accepts clean integer lists (whitespace, negatives, empty)", () => {
    expect(parseByMonthDay("1,15")).toEqual([1, 15])
    expect(parseByMonthDay(" 28 , 29 ")).toEqual([28, 29])
    expect(parseByMonthDay("-1")).toEqual([-1])
    expect(parseByMonthDay("")).toEqual([])
    expect(parseByMonthDay("   ")).toEqual([])
  })

  it("rejects decimal typos instead of silently coercing them", () => {
    // parseInt used to coerce "1.5" → day 1: the user saves a recurring
    // plan on a different day than they typed, with no error anywhere.
    expect(() => parseByMonthDay("1.5")).toThrow("Ganzzahlen")
    expect(() => parseByMonthDay("1,2.5")).toThrow("Ganzzahlen")
    // digits glued via a letter ("O" vs "0") reject the same way
    expect(() => parseByMonthDay("1O")).toThrow("Ganzzahlen")
    // "+5" is not an RFC BYMONTHDAY spelling either
    expect(() => parseByMonthDay("+5")).toThrow("Ganzzahlen")
  })

  it("keeps the existing range/duplicate guards", () => {
    expect(() => parseByMonthDay("0")).toThrow("Ungültige Monatstage")
    expect(() => parseByMonthDay("32")).toThrow("Ungültige Monatstage")
    expect(() => parseByMonthDay("1,1")).toThrow("Ungültige Monatstage")
  })
})

describe("yearlyNoMonthHint (mode-accurate engine semantics)", () => {
  it("mday without BYMONTH repeats EVERY month, not just January", () => {
    // rrule: FREQ=YEARLY;BYMONTHDAY=15 (no BYMONTH) → the 15th of every
    // month (verified against the engine) — the copy used to claim the
    // opposite (swapped modes)
    const hint = yearlyNoMonthHint("mday")
    expect(hint).toContain("jedem Monat")
    expect(hint).toContain("12× pro Jahr")
    expect(hint).not.toContain("Januar")
  })

  it("wday without BYMONTH counts the ordinal across the YEAR", () => {
    // rrule: FREQ=YEARLY;BYDAY=1MO (no BYMONTH) → first Monday of the year
    // (January); "letzte" → last weekday of the year (December)
    const hint = yearlyNoMonthHint("wday")
    expect(hint).toContain("ganze Jahr")
    expect(hint).toContain("erster Montag des Jahres")
    expect(hint).toContain("letzter Freitag")
    expect(hint).not.toContain("jedem Monat")
  })
})

describe("describeRrule YEARLY cadence (engine-accurate)", () => {
  it("yearless BYMONTHDAY repeats monthly, not annually", () => {
    // engine semantics (probe-verified): FREQ=YEARLY;BYMONTHDAY=15 fires on
    // the 15th of EVERY month — the badge used to lie with "jährlich am 15."
    expect(describeRrule("FREQ=YEARLY;BYMONTHDAY=15")).toBe(
      "am 15. jedes Monats"
    )
    expect(describeRrule("FREQ=YEARLY;BYMONTHDAY=1,15,-1")).toBe(
      "am 1./15./letzten Tag jedes Monats"
    )
    expect(describeRrule("FREQ=YEARLY;INTERVAL=2;BYMONTHDAY=15")).toBe(
      "am 15. jedes Monats (alle 2 Jahre)"
    )
    // the COUNT/UNTIL suffix composes onto the yearless wording too
    expect(describeRrule("FREQ=YEARLY;BYMONTHDAY=15;COUNT=5")).toBe(
      "am 15. jedes Monats, 5×"
    )
  })

  it("yearless plain BYDAY repeats weekly", () => {
    // FREQ=YEARLY;BYDAY=MO → every Monday (~52×/year), not once a year
    expect(describeRrule("FREQ=YEARLY;BYDAY=MO")).toBe("jeden Mo")
    expect(describeRrule("FREQ=YEARLY;INTERVAL=2;BYDAY=MO")).toBe(
      "jeden Mo (alle 2 Jahre)"
    )
  })

  it("genuinely annual shapes keep the yearly wording", () => {
    // yearless ordinal BYDAY counts across the whole year (January)
    expect(describeRrule("FREQ=YEARLY;BYDAY=1MO")).toBe("jährlich am 1. Mo")
    expect(describeRrule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15")).toBe(
      "jährlich in März am 15."
    )
    expect(describeRrule("FREQ=YEARLY;BYMONTH=3;BYDAY=1FR")).toBe(
      "jährlich in März am 1. Fr"
    )
    expect(describeRrule("FREQ=YEARLY")).toBe("jährlich")
    // interval > 1 is part of the cadence — surfaced, not swallowed
    expect(
      describeRrule("FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=15")
    ).toBe("alle 2 Jahre in März am 15.")
    expect(describeRrule("FREQ=YEARLY;INTERVAL=2;BYDAY=1MO")).toBe(
      "alle 2 Jahre am 1. Mo"
    )
  })

  it("BYDAY + BYMONTHDAY intersect — full raw rule instead of a compact lie", () => {
    // only Monday 1sts qualify (once a year, some years none) — "jährlich
    // am 1." would hide the weekday limiter
    expect(describeRrule("FREQ=YEARLY;BYMONTHDAY=1;BYDAY=MO")).toBe(
      "FREQ=YEARLY;BYMONTHDAY=1;BYDAY=MO"
    )
    expect(describeRrule("FREQ=YEARLY;BYMONTH=3;BYDAY=MO;BYMONTHDAY=1")).toBe(
      "FREQ=YEARLY;BYMONTH=3;BYDAY=MO;BYMONTHDAY=1"
    )
  })
})

describe("describeRrule ordinal BYDAY", () => {
  it("describes every RFC ordinal (5FR is pickable, 10MO stays beyond the picker)", () => {
    // validation accepts every RFC ordinal on MONTHLY rules, so a stored
    // 5FR/10MO plan can exist — the Wiederholung badge must say "5. Fr"/
    // "10. Mo" instead of silently degrading to a bare "monatlich"
    expect(describeRrule("FREQ=MONTHLY;BYDAY=5FR")).toBe("am 5. Fr")
    expect(describeRrule("FREQ=MONTHLY;BYDAY=10MO")).toBe("am 10. Mo")
    // unchanged neighbours: the builder's own ordinals and multi-ordinal
    // lists
    expect(describeRrule("FREQ=MONTHLY;BYDAY=1FR")).toBe("am 1. Fr")
    expect(describeRrule("FREQ=MONTHLY;BYDAY=-1FR")).toBe("am letzten Fr")
    expect(describeRrule("FREQ=MONTHLY;BYDAY=1FR,-1FR")).toBe(
      "am 1. Fr/letzten Fr"
    )
    // plain weekday (no ordinal) repeats on EVERY matching weekday of the
    // month — the badge must say so instead of a bare "monatlich"
    expect(describeRrule("FREQ=MONTHLY;BYDAY=MO")).toBe("jeden Mo im Monat")
    expect(describeRrule("FREQ=MONTHLY;BYDAY=SA,SU")).toBe(
      "jeden Sa/So im Monat"
    )
    expect(describeRrule("FREQ=MONTHLY;INTERVAL=3;BYDAY=MO")).toBe(
      "jeden Mo im Monat (alle 3 Monate)"
    )
    // mixed ordinal + plain lists have no truthful compression → raw rule
    // ("am 1. Fr/Mo" would hide that the plain Mo is NOT the first one)
    expect(describeRrule("FREQ=MONTHLY;BYDAY=1FR,MO")).toBe(
      "FREQ=MONTHLY;BYDAY=1FR,MO"
    )
    // plain weekday + mday intersect → raw (the weekday limiter must not
    // vanish, same as the YEARLY BYDAY+BYMONTHDAY case)
    expect(describeRrule("FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=1")).toBe(
      "FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=1"
    )
  })
})

describe("describeRrule plain weekday + BYMONTH (yearly)", () => {
  it("weekday-repeats-within-month cadence is never 'jährlich'", () => {
    // FREQ=YEARLY;BYMONTH=1,2;BYDAY=MO fires on every Monday of Jan/Feb
    // (~8–9×/year) — "jährlich in Januar/Februar am Mo" would lie
    expect(describeRrule("FREQ=YEARLY;BYMONTH=1,2;BYDAY=MO")).toBe(
      "in Januar/Februar jeden Mo"
    )
    expect(describeRrule("FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYDAY=WE")).toBe(
      "in März jeden Mi (alle 2 Jahre)"
    )
  })

  it("mixed ordinal + plain lists fall back to the raw rule", () => {
    expect(describeRrule("FREQ=YEARLY;BYMONTH=3;BYDAY=1FR,MO")).toBe(
      "FREQ=YEARLY;BYMONTH=3;BYDAY=1FR,MO"
    )
  })
})
