// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { parseRruleToForm } from "@/components/planning/plan-dialog"

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
