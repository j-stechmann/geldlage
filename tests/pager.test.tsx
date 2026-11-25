// @vitest-environment jsdom
import React from "react"
import { describe, it, expect, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { Pager } from "@/components/pager"
// registers RTL cleanup, the act environment and jest-dom matchers
import "./helpers-dom"

function renderPager(opts: {
  page?: number
  pageCount?: number
  onPageChange?: React.Dispatch<React.SetStateAction<number>>
}) {
  const onPageChange = opts.onPageChange ?? vi.fn()
  render(
    <Pager
      page={opts.page ?? 1}
      pageCount={opts.pageCount ?? 5}
      onPageChange={onPageChange}
      summary="Transaktionen"
      indicator="1 / 5"
    />
  )
  return {
    onPageChange,
    next: screen.getByRole("button", { name: /Weiter/ }),
    prev: screen.getByRole("button", { name: /Zurück/ }),
  }
}

describe("Pager", () => {
  it("handles next/prev through functional updaters", () => {
    const onPageChange = vi.fn()
    const { next, prev } = renderPager({ page: 2, onPageChange })

    fireEvent.click(next)
    fireEvent.click(prev)

    const [nextUpdater] = onPageChange.mock.calls[0]
    const [prevUpdater] = onPageChange.mock.calls[1]
    expect(typeof nextUpdater).toBe("function")
    expect(typeof prevUpdater).toBe("function")
    // two batched activations compose instead of both reading the stale prop
    expect(nextUpdater(1)).toBe(2)
    expect(nextUpdater(2)).toBe(3)
    expect(prevUpdater(3)).toBe(2)
  })

  it("clamps at both ends via the updater", () => {
    const onPageChange = vi.fn()
    const { next, prev } = renderPager({
      page: 2,
      pageCount: 3,
      onPageChange,
    })

    fireEvent.click(next)
    fireEvent.click(prev)

    const [nextUpdater] = onPageChange.mock.calls[0]
    const [prevUpdater] = onPageChange.mock.calls[1]
    expect(nextUpdater(3)).toBe(3)
    expect(prevUpdater(1)).toBe(1)
  })

  it("advances a useState harness", () => {
    function Harness() {
      const [page, setPage] = React.useState(1)
      return (
        <>
          <output data-testid="page">{page}</output>
          <Pager
            page={page}
            pageCount={5}
            onPageChange={setPage}
            summary="s"
            indicator={`${page} / 5`}
          />
        </>
      )
    }

    render(<Harness />)
    const next = screen.getByRole("button", { name: /Weiter/ })
    act(() => {
      next.click()
      next.click()
    })
    expect(screen.getByTestId("page").textContent).toBe("3")
  })
})
