import { describe, it, expect } from "vitest"
import { topCategoriesTooltip } from "@/components/analytics-charts"

/**
 * Denominator regression (planned-vs-actual Top-Ausgabenkategorien): the
 * Ist side divides by the filtered period's total, the prediction side by the
 * forecast horizon's total. Each segment prints its own amount exactly once
 * and names its basis, so a predicted amount is never double-printed and a
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

  it("Ist + Prognose rows keep the Ist share on the Ist amount", () => {
    expect(
      topCategoriesTooltip(500, "value", {
        payload: { value: 500, predicted: 100.5, share: 0.5 },
      })
    ).toBe("500,00 € (50 % der Ist-Ausgaben)")
  })

  it("the prediction segment prints its own amount, never a supplement", () => {
    expect(
      topCategoriesTooltip(100.5, "predicted", {
        payload: { value: 500, predicted: 100.5, share: 0.5 },
      })
    ).toBe("100,50 € Prognose")
  })

  it("prediction-only rows put the horizon share on the predicted amount", () => {
    expect(
      topCategoriesTooltip(0, "value", {
        payload: { value: 0, predicted: 100, share: 0.12 },
      })
    ).toBe("0,00 €")
    expect(
      topCategoriesTooltip(100, "predicted", {
        payload: { value: 0, predicted: 100, share: 0.12 },
      })
    ).toBe("100,00 € Prognose (12 % der prognostizierten Ausgaben)")
  })

  it("without prediction (predicted absent) keeps the Ist denominator label", () => {
    expect(
      topCategoriesTooltip(1234.5, "value", {
        payload: { value: 1234.5, share: 0.999 },
      })
    ).toBe("1.234,50 € (>99 % der Ist-Ausgaben)")
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

  it("bounds a share that would round to a false 0 % / 100 %", () => {
    expect(
      topCategoriesTooltip(100, "predicted", {
        payload: { value: 0, predicted: 100, share: 0 },
      })
    ).toBe("100,00 € Prognose")
    // non-zero shares below 0.5 % are not zero
    expect(
      topCategoriesTooltip(100, "predicted", {
        payload: { value: 0, predicted: 100, share: 0.001 },
      })
    ).toBe("100,00 € Prognose (<1 % der prognostizierten Ausgaben)")
    // a share just short of the total is not 100 %
    expect(
      topCategoriesTooltip(100, "predicted", {
        payload: { value: 0, predicted: 100, share: 0.996 },
      })
    ).toBe("100,00 € Prognose (>99 % der prognostizierten Ausgaben)")
  })
})
