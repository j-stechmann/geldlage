// @vitest-environment jsdom
/**
 * Layout regression for the container-query conversion (PR #76 follow-up):
 * every responsive grid/col-span inside <main> must key its breakpoint off
 * the @container on <main> (@min-[…px]: variants), not the viewport
 * (sm:/lg:) — viewport classes keep firing while the agent dock squeezes
 * main below the threshold, so cards span columns the grid no longer has.
 *
 * The fetch stub resolves never, so pages render their loading skeletons —
 * no Recharts internals mount in jsdom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { screen } from "@testing-library/react"
import { createElement } from "react"
import DashboardPage from "@/app/page"
import ImportsPage from "@/app/imports/page"
import { ActiveImportProvider } from "@/components/active-import-provider"
import { renderWithQuery } from "./helpers-dom"

/** Pendants to the real <main> @container thresholds (px-4 content box). */
const KPI_ROW = ["@min-[640px]:grid-cols-2", "@min-[1024px]:grid-cols-5"]
const CHARTS_GRID = "@min-[1024px]:grid-cols-3"
const SPAN_2 = "@min-[1024px]:col-span-2"
const IMPORTS_GRID = "@min-[1024px]:grid-cols-2"

function stubPendingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {}))
  )
}

/** The Card hosting a chart/KPI, located via its unique title text. */
function cardFor(title: string): HTMLElement {
  const el = screen.getByText(title)
  const card = el.closest('[data-slot="card"]')
  expect(card).not.toBeNull()
  return card as HTMLElement
}

describe("grids inside <main> use container-query breakpoints", () => {
  beforeEach(() => {
    stubPendingFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("dashboard: KPI row re-wraps against main, not the viewport", () => {
    renderWithQuery(createElement(DashboardPage))
    const grid = cardFor("Aktueller Kontostand").parentElement
    expect(grid).toHaveClass(...KPI_ROW)
    expect(grid?.className).not.toMatch(/(^|\s)(sm|lg):/)
  })

  it("dashboard: charts grid and wide charts are container-keyed", () => {
    // Regression: the Cards' lg:col-span-2 outlived the grid's move to
    // container queries — with the dock open on a wide window the grid
    // fell back to one column while the viewport classes kept spanning 2,
    // creating implicit columns instead of a stacked full-width layout.
    renderWithQuery(createElement(DashboardPage))
    const grid = cardFor("Monatlicher Cashflow").parentElement
    expect(grid).toHaveClass(CHARTS_GRID)
    expect(grid?.className).not.toMatch(/(^|\s)lg:/)

    // the two wide charts span 2 — but only under the container variant
    for (const title of ["Monatlicher Cashflow", "Kontostand über Zeit"]) {
      expect(cardFor(title)).toHaveClass(SPAN_2)
      expect(cardFor(title).className).not.toContain("lg:col-span-2")
    }
    // the narrow charts must not span at all (no implicit columns)
    for (const title of ["Top Ausgabenkategorien", "Monatssaldo"]) {
      expect(cardFor(title).className).not.toContain("col-span")
    }
  })

  it("imports: dropzone grid reflows against main, not the viewport", () => {
    renderWithQuery(
      createElement(ActiveImportProvider, null, createElement(ImportsPage))
    )
    const grid = cardFor("CSV-Datei hier ablegen").parentElement
    expect(grid).toHaveClass(IMPORTS_GRID)
    expect(grid?.className).not.toMatch(/(^|\s)lg:/)
  })
})
