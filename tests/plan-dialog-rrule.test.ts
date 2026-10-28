// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import {
  parseByMonthDay,
  parseRruleToForm,
  yearlyNoMonthHint,
  freqPickPatch,
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
 * itself produces (YEARLY with 2+ month chips + weekday pattern, whose
 * mday-mapped rebuild silently dropped BYDAY) — so a routine edit-save
 * silently rewrote those plans' recurrences. That shape now maps into the
 * wday fields faithfully (parity + set compare prove the rebuild); parity
 * keeps any OTHER dropped part from reading as faithful.
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
      // 2+ month chips beside the weekday pattern: buildRrule writes
      // BYMONTH=<list> next to BYDAY, the wday mapping carries every part
      "FREQ=YEARLY;BYMONTH=3,6;BYDAY=1FR",
      // ordinal weekday-yearly without BYMONTH (ordinal counts across the
      // year — the dialog's hint documents exactly that semantics)
      "FREQ=YEARLY;BYDAY=1MO",
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

  it("maps the 2+-month-chip weekday-yearly shape into the wday fields", () => {
    // THE historical silent-rewrite shape: the mday mapping rebuilt
    // FREQ=YEARLY;BYMONTH=3,6 — silently dropping BYDAY=1FR — so an
    // untouched edit-save changed the recurrence. The faithful wday
    // mapping carries the chips + ordinal; rawDirty=false is the gate's
    // certificate (rebuildParity + occurrence-set equality passed).
    const o = parseRruleToForm("FREQ=YEARLY;BYMONTH=3,6;BYDAY=1FR", DTSTART)
    expect(o.rawDirty).toBe(false)
    expect(o.yearlyMode).toBe("wday")
    expect(o.byMonth).toEqual(["3", "6"])
    expect(o.ordinal).toBe("1")
    expect(o.ordinalDay).toBe("FR")
  })

  it("keeps the raw text authoritative for shapes the builder can't render", () => {
    const cases = [
      // multi-ordinal BYDAY (raw field / API / agent)
      "FREQ=MONTHLY;BYDAY=1FR,-1FR",
      // ordinal beyond the picker (1–5, "letzte") — would render an empty
      // pattern select despite round-tripping the same rule
      "FREQ=MONTHLY;BYDAY=-2SU",
      // yearless PLAIN weekday: yearly wday mode always writes an ordinal,
      // mday mode writes no BYDAY — every-Monday-yearly is inexpressible
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

  it("maps 1MO yearly anchored on the first Monday into the wday fields", () => {
    // first Monday of 2026 IS Jan 5 — a plain-yearly rule anchored there
    // coincides with "1MO yearly" through all of 2026 (2027 drifts: Jan 4
    // vs Jan 5). The OLD mday-mapped rebuild was exactly that plain yearly
    // — the alias the 800-day window existed to catch. The faithful wday
    // mapping rebuilds FREQ=YEARLY;BYDAY=1MO itself, so the alias cannot
    // arise; the window compare stays as defense in depth.
    const o = parseRruleToForm("FREQ=YEARLY;BYDAY=1MO", "2026-01-05")
    expect(o.rawDirty).toBe(false)
    expect(o.yearlyMode).toBe("wday")
    expect(o.ordinal).toBe("1")
    expect(o.ordinalDay).toBe("MO")
    expect(o.byMonth).toEqual([])
  })

  it("duplicate BY*-list tokens compare as one and map into the builder", () => {
    // rrule preserves dup tokens through parse AND serialization, so dup
    // noise is genuinely storable ("BYDAY=MO,MO" round-trips validateRrule
    // verbatim). RFC list parts are unordered and duplicate-free — the
    // parity signature must treat the dup as one token, or the rule would
    // route raw and stay noisy forever; the builder's save then rewrites
    // the stored text dup-free.
    const w = parseRruleToForm("FREQ=WEEKLY;BYDAY=MO,MO", DTSTART)
    expect(w.rawDirty, "weekly dup BYDAY maps").toBe(false)
    expect(w.byDay).toEqual(["MO"])
    const m = parseRruleToForm("FREQ=MONTHLY;BYMONTHDAY=1,1", DTSTART)
    expect(m.rawDirty, "monthly dup BYMONTHDAY maps").toBe(false)
    expect(m.byMonthDayText).toBe("1")
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
    // first occurrence 2100-02-05 (~100y out): the mis-rebuilt rule
    // (FREQ=YEARLY;INTERVAL=100;BYMONTH=2,3) silently drops BYDAY —
    // multi-ordinal BYDAY has no builder field, so the mday mapping drops
    // the whole part and parity is the ONLY guard (both window sets empty)
    const o = parseRruleToForm(
      "FREQ=YEARLY;INTERVAL=100;BYMONTH=2,3;BYDAY=1FR,-1FR",
      "2000-04-01"
    )
    expect(o.rawDirty).toBe(true)
    expect(o.rawRrule).toBe(
      "FREQ=YEARLY;INTERVAL=100;BYMONTH=2,3;BYDAY=1FR,-1FR"
    )
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

  it("representable ultra-sparse wday rules stay builder-owned", () => {
    // 2 month chips + last-Friday on a century cadence (first occurrence
    // 2100-02-26): the wday mapping carries INTERVAL, BYMONTH=2,3 AND
    // BYDAY=-1FR — the rebuild is the stored rule itself, both window sets
    // empty, parity equal → builder-owned (the -1FR drop this shape used to
    // suffer only befalls rules the mapping genuinely can't carry)
    const o = parseRruleToForm(
      "FREQ=YEARLY;INTERVAL=100;BYMONTH=2,3;BYDAY=-1FR",
      "2000-04-01"
    )
    expect(o.rawDirty).toBe(false)
    expect(o.yearlyMode).toBe("wday")
    expect(o.byMonth).toEqual(["2", "3"])
    expect(o.ordinal).toBe("-1")
    expect(o.ordinalDay).toBe("FR")
    expect(o.interval).toBe(100)
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

  it("mday with the Tag field still empty describes the bare FREQ=YEARLY (anniversary), not 12×/year", () => {
    // with no day text the builder composes a bare FREQ=YEARLY — its
    // expansion is the DTSTART anniversary (1×/year, engine-verified:
    // "2026-06-15" → 2026/27/28-06-15) — the old copy claimed the not-yet-
    // true "12× pro Jahr" right above a preview showing the anniversary
    const hint = yearlyNoMonthHint("mday", false)
    expect(hint).toContain("Startdatum")
    expect(hint).not.toContain("kehrt dann in jedem Monat")
    // the day-set copy (above) and the wday copy are unaffected
    expect(yearlyNoMonthHint("mday", true)).toContain("12× pro Jahr")
    expect(yearlyNoMonthHint("wday", false)).toContain("ganze Jahr")
  })
})

describe("freqPickPatch (same-value select taps stay no-ops)", () => {
  /**
   * Base UI fires the select's onValueChange on EVERY item press — also
   * on re-picking the already-displayed value. The handler used to
   * unconditionally clear rawDirty, so tapping the currently displayed
   * "Monatlich" on a raw-authoritative rule (e.g. the builder-
   * unrepresentable "FREQ=MONTHLY;BYDAY=1FR,-1FR") left raw mode with the
   * STALE builder state, the save button armed on the rebuilt rule and an
   * untouched-looking edit-save silently rewrote the recurrence to plain
   * FREQ=MONTHLY. A same-value pick must be a no-op.
   */
  it("a same-value pick returns null (raw mode stays authoritative)", () => {
    expect(freqPickPatch("MONTHLY", "MONTHLY")).toBeNull()
    expect(freqPickPatch("once", "once")).toBeNull()
    expect(freqPickPatch("DAILY", "DAILY")).toBeNull()
    // the no-args/clear shapes: a null pick maps to "once" — no-op when
    // "once" is already displayed
    expect(freqPickPatch("once", null)).toBeNull()
    expect(freqPickPatch("once", undefined)).toBeNull()
  })

  it("a genuine switch exits raw mode and maps the display value", () => {
    expect(freqPickPatch("MONTHLY", "once")).toEqual({
      freq: "",
      rawDirty: false,
    })
    expect(freqPickPatch("once", "DAILY")).toEqual({
      freq: "DAILY",
      rawDirty: false,
    })
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

describe("describeRrule BY* narrowing falls back to the raw rule", () => {
  // All shapes below are only reachable via the raw "RRULE (erweitert)"
  // field (the builder cannot produce them), but validation accepts them —
  // so a stored plan can exist and its Wiederholung badge must describe
  // what the engine actually fires, never a bare frequency word.

  it("DAILY with BYDAY/BYMONTHDAY/BYMONTH is never 'täglich'", () => {
    // engine-verified: DAILY;BYDAY=MO,WE fires Weds+Mons only (werktags)
    expect(describeRrule("FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR")).toBe(
      "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"
    )
    // DAILY;BYMONTHDAY=1 = the 1st of every month, not every day
    expect(describeRrule("FREQ=DAILY;BYMONTHDAY=1")).toBe(
      "FREQ=DAILY;BYMONTHDAY=1"
    )
    // DAILY;BYMONTH=7 fires only in July — in a leap-from-1900 table this
    // plan stays silent for 11 months of every year
    expect(describeRrule("FREQ=DAILY;BYMONTH=7")).toBe("FREQ=DAILY;BYMONTH=7")
    expect(describeRrule("FREQ=DAILY;INTERVAL=2;BYDAY=MO")).toBe(
      "FREQ=DAILY;INTERVAL=2;BYDAY=MO"
    )
  })

  it("plain DAILY keeps the compact wording", () => {
    // the escape must not swallow the builder-producible shapes
    expect(describeRrule("FREQ=DAILY")).toBe("täglich")
    expect(describeRrule("FREQ=DAILY;INTERVAL=3")).toBe("alle 3 Tage")
  })

  it("WEEKLY with BYMONTHDAY/BYMONTH is never 'wöchentlich'", () => {
    // engine-honored despite being RFC-forbidden on WEEKLY: fires on the
    // 15th of EVERY month — the raw rule is the only truthful badge
    expect(describeRrule("FREQ=WEEKLY;BYMONTHDAY=15")).toBe(
      "FREQ=WEEKLY;BYMONTHDAY=15"
    )
    // FREQ=WEEKLY;BYMONTH=2 fires on Feb-weekdays only (engine-verified)
    expect(describeRrule("FREQ=WEEKLY;BYMONTH=2;BYDAY=MO,WE")).toBe(
      "FREQ=WEEKLY;BYMONTH=2;BYDAY=MO,WE"
    )
  })

  it("plain WEEKLY keeps the humanized wording (spacing + connector)", () => {
    // regression: the weekday list used to be glued to the cadence
    // ("wöchentlichMo/Mi", "alle 2 WochenFr") — the MONTHLY branch's
    // " am " connector applies here too, and a BYDAY-less rule keeps
    // the bare cadence
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO,WE")).toBe(
      "wöchentlich am Mo/Mi"
    )
    expect(describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe(
      "alle 2 Wochen am Fr"
    )
    expect(describeRrule("FREQ=WEEKLY")).toBe("wöchentlich")
    expect(describeRrule("FREQ=WEEKLY;INTERVAL=2")).toBe("alle 2 Wochen")
  })

  it("WEEKLY with WKST + multi-week INTERVAL is never 'alle N Wochen'", () => {
    // WKST moves the week boundary the interval expands across (RFC 5545,
    // significant for WEEKLY with INTERVAL > 1): WKST=MO and WKST=SU fire
    // different weeks — the raw rule is the only truthful badge
    expect(describeRrule("FREQ=WEEKLY;INTERVAL=2;WKST=SU")).toBe(
      "FREQ=WEEKLY;INTERVAL=2;WKST=SU"
    )
    expect(describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU")).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU"
    )
    // INTERVAL=1 fires every week, so WKST cannot change any occurrence
    // (the semantics-free reasoning rebuildParity uses in plan-dialog.tsx)
    // — the humanized badge must survive a semantics-free WKST
    expect(describeRrule("FREQ=WEEKLY;WKST=SU")).toBe("wöchentlich")
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO;WKST=SU")).toBe(
      "wöchentlich am Mo"
    )
  })

  it("MONTHLY with BYMONTH is never 'monatlich'", () => {
    // MONTHLY;BYMONTH=2;BYMONTHDAY=1 = once a year (February 1st only)
    expect(describeRrule("FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=1")).toBe(
      "FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=1"
    )
    expect(describeRrule("FREQ=MONTHLY;BYMONTH=7")).toBe(
      "FREQ=MONTHLY;BYMONTH=7"
    )
    // month filter + weekday pattern also exceeds the compact wording
    expect(describeRrule("FREQ=MONTHLY;BYMONTH=2,3;BYDAY=MO")).toBe(
      "FREQ=MONTHLY;BYMONTH=2,3;BYDAY=MO"
    )
  })

  it("BYSETPOS escapes BEFORE the COUNT/UNTIL suffix", () => {
    // the ordinal wording of the BYDAY branches ignores BYSETPOS, which
    // re-selects from the expanded set: with COUNT=5 the old tail order
    // returned "am 1. Mo, 5×" for a rule that fires the LAST Monday
    expect(describeRrule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO;COUNT=5")).toBe(
      "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO;COUNT=5"
    )
    expect(describeRrule("FREQ=MONTHLY;BYSETPOS=1;BYMONTHDAY=1,15")).toBe(
      "FREQ=MONTHLY;BYSETPOS=1;BYMONTHDAY=1,15"
    )
  })

  it("an UNTIL the humanizer cannot parse falls back to the raw rule", () => {
    // describeUntil parses the compact UNTIL every validateRrule-stored rule
    // carries; an UNTIL it cannot (a dashed hand-written row) must not
    // silently lose its end condition in the badge — that would read as an
    // unbounded rule. The honest fallback is the full raw rule (the same
    // escape hatch as BYSETPOS).
    expect(describeRrule("FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=2026-01-01")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=2026-01-01"
    )
    // compact date-only / datetime forms keep the composed badge
    expect(describeRrule("FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20261231")).toBe(
      "am 1., bis 31.12.2026"
    )
    expect(
      describeRrule("FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20261231T120000Z")
    ).toBe("am 1., bis 31.12.2026")
  })
})
