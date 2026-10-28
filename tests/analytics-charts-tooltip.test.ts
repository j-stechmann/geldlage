import { describe, it, expect } from "vitest"
import { topCategoriesTooltip } from "@/components/analytics-charts"

/**
 * Denominator regression (planned-vs-actual Top-Ausgabenkategorien): the
 * tooltip suffix " (N %)" must only ever name the Ist-period share of rows
 * that actually have Ist money; planned-only rows and the hovered planned
 * segment must not print a share whose denominator (the planned horizon
 * total) is a different population — nor may the planned segment
 * double-print itself ("100,00 € + 100,00 € geplant").
 */

describe("topCategoriesTooltip", () => {
  it("pure Ist rows keep the plain amount + share readout", () => {
    expect(
      topCategoriesTooltip(500.25, "value", {
        payload: { value: 500.25, share: 0.335 },
      })
    ).toBe("500,25 € (34 %)")
  })

  it("Ist + geplant rows append the planned supplement, Ist share intact", () => {
    expect(
      topCategoriesTooltip(500, "value", {
        payload: { value: 500, planned: 100.5, share: 0.5 },
      })
    ).toBe("500,00 € + 100,50 € geplant (50 %)")
  })

  it("planned-only rows never inherit the Ist-period share", () => {
    expect(
      topCategoriesTooltip(0, "value", {
        payload: { value: 0, planned: 100, share: 0.12 },
      })
    ).toBe("0,00 € + 100,00 € geplant")
  })

  it("the hovered planned segment prints only its supplement", () => {
    expect(
      topCategoriesTooltip(100, "planned", {
        payload: { value: 500, planned: 100, share: 0.5 },
      })
    ).toBe("100,00 € geplant")
  })

  it("forecast off (planned absent) reproduces the pre-planning readout", () => {
    expect(
      topCategoriesTooltip(1234.5, "value", {
        payload: { value: 1234.5, share: 0.999 },
      })
    ).toBe("1.234,50 € (100 %)")
  })

  it("missing payload/payload fields degrade to the bare amount", () => {
    expect(topCategoriesTooltip(7.5, "value", undefined)).toBe("7,50 €")
    expect(topCategoriesTooltip(7.5, "value", {})).toBe("7,50 €")
  })
})
