import { describe, it, expect } from "vitest"
import { topCategoriesTooltip } from "@/components/analytics-charts"

/**
 * Denominator regression (planned-vs-actual Top-Ausgabenkategorien): the
 * Ist side divides by the filtered period's total, the planned side by the
 * forecast horizon's total. Each segment prints its own amount exactly once
 * and names its basis, so a planned amount is never double-printed and a
 * share is never silently attributed to the other scope.
 */

describe("topCategoriesTooltip", () => {
  it("pure Ist rows name the Ist-period denominator", () => {
    expect(
      topCategoriesTooltip(500.25, "value", {
        payload: { value: 500.25, share: 0.335 },
      })
    ).toBe("500,25 € (34 % der Ist-Ausgaben)")
  })

  it("Ist + geplant rows keep the Ist share on the Ist amount", () => {
    expect(
      topCategoriesTooltip(500, "value", {
        payload: { value: 500, planned: 100.5, share: 0.5 },
      })
    ).toBe("500,00 € (50 % der Ist-Ausgaben)")
  })

  it("the planned segment prints its own amount, never a supplement", () => {
    expect(
      topCategoriesTooltip(100.5, "planned", {
        payload: { value: 500, planned: 100.5, share: 0.5 },
      })
    ).toBe("100,50 € geplant")
  })

  it("planned-only rows put the horizon share on the planned amount", () => {
    expect(
      topCategoriesTooltip(0, "value", {
        payload: { value: 0, planned: 100, share: 0.12 },
      })
    ).toBe("0,00 €")
    expect(
      topCategoriesTooltip(100, "planned", {
        payload: { value: 0, planned: 100, share: 0.12 },
      })
    ).toBe("100,00 € geplant (12 % der geplanten Ausgaben)")
  })

  it("forecast off (planned absent) keeps the Ist denominator label", () => {
    expect(
      topCategoriesTooltip(1234.5, "value", {
        payload: { value: 1234.5, share: 0.999 },
      })
    ).toBe("1.234,50 € (100 % der Ist-Ausgaben)")
  })

  it("missing payload/payload fields degrade to the bare amount", () => {
    expect(topCategoriesTooltip(7.5, "value", undefined)).toBe("7,50 €")
    expect(topCategoriesTooltip(7.5, "value", {})).toBe("7,50 €")
    expect(
      topCategoriesTooltip(500, "value", { payload: { value: 500 } })
    ).toBe("500,00 €")
    expect(
      topCategoriesTooltip(0, "value", { payload: { value: 0, share: 0 } })
    ).toBe("0,00 €")
  })

  it("treats a share that rounds to zero as absent", () => {
    expect(
      topCategoriesTooltip(100, "planned", {
        payload: { value: 0, planned: 100, share: 0 },
      })
    ).toBe("100,00 € geplant")
    expect(
      topCategoriesTooltip(100, "planned", {
        payload: { value: 0, planned: 100, share: 0.001 },
      })
    ).toBe("100,00 € geplant")
  })
})
