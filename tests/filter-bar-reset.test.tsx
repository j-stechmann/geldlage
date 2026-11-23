// @vitest-environment jsdom
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen } from "@testing-library/react"
import { FilterBar } from "@/components/filter-bar"
import { EMPTY_FILTERS, type TableFilters } from "@/lib/filters"
import { renderWithQuery, stubFetch, stubLocalStorage } from "./helpers-dom"

beforeEach(() => {
  vi.useFakeTimers()
  stubLocalStorage()
  stubFetch([
    { url: /\/api\/accounts$/, json: { accounts: [] } },
    { url: /\/api\/categories$/, json: { categories: [] } },
  ])
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Stateful harness: like the real page, it applies every emitted filter
 * object to the prop. A bare spy would let the hook's external resync see a
 * stale `value` and legitimately emit a second time.
 *
 * The real-world hazard is event-loop ordering (a timer already due when the
 * click handler runs); fake timers flush callbacks immediately, so this test
 * pins the observable outcome. The hook test "cancel drops a pending emit"
 * pins the primitive the reset handler relies on.
 */
function Harness({ onChange }: { onChange: (f: TableFilters) => void }) {
  const [filters, setFilters] = React.useState<TableFilters>(EMPTY_FILTERS)
  return (
    <FilterBar
      filters={filters}
      onChange={(next) => {
        onChange(next)
        setFilters(next)
      }}
    />
  )
}

describe("FilterBar reset", () => {
  it("cancels a due debounce and applies EMPTY_FILTERS exactly once", () => {
    const onChange = vi.fn()
    renderWithQuery(<Harness onChange={onChange} />)

    const input = screen.getByPlaceholderText(
      "Suchen (Empfänger, Verwendungszweck)…"
    )

    // commit "miete" so the hook's lastEmitted is non-empty
    fireEvent.change(input, { target: { value: "miete" } })
    act(() => vi.advanceTimersByTime(300))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTERS, q: "miete" })

    // type a new search, then reset just before its timer is due
    fireEvent.change(input, { target: { value: "miete2" } })
    act(() => vi.advanceTimersByTime(299))

    fireEvent.click(screen.getByTitle("Filter zurücksetzen"))
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_FILTERS)
    expect(onChange).toHaveBeenCalledTimes(2)

    // the dropped timer must not re-apply the pre-reset search
    act(() => vi.advanceTimersByTime(300))
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).not.toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: "miete2" })
  })
})

describe("FilterBar date inputs", () => {
  it("applies a valid ISO date", () => {
    const onChange = vi.fn()
    renderWithQuery(<Harness onChange={onChange} />)

    fireEvent.change(screen.getByLabelText("Von"), {
      target: { value: "2026-01-01" },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      ...EMPTY_FILTERS,
      dateFrom: "2026-01-01",
    })
  })

  it("never stores a date outside the four-digit ISO range", () => {
    const onChange = vi.fn()
    renderWithQuery(<Harness onChange={onChange} />)

    // Chromium's date input accepts a year > 9999; the list routes answer it
    // with 400 invalid_date, so the handler must not put it into filter state
    fireEvent.change(screen.getByLabelText("Von"), {
      target: { value: "10000-01-01" },
    })
    for (const [next] of onChange.mock.calls) {
      expect(next.dateFrom).not.toBe("10000-01-01")
    }
  })
})
