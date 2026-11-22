// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useDebouncedSearch } from "@/hooks/use-debounced-search"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("useDebouncedSearch", () => {
  it("emits the trimmed draft after the delay", () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useDebouncedSearch("", onCommit))

    act(() => result.current.setDraft("  abc  "))
    expect(onCommit).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(299))
    expect(onCommit).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(onCommit).toHaveBeenCalledWith("abc")
  })

  it("resyncs the draft when the external value changes", () => {
    const onCommit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSearch(value, onCommit),
      { initialProps: { value: "" } }
    )

    rerender({ value: "external" })
    expect(result.current.draft).toBe("external")
  })

  it("does not clobber the draft with its own emitted value", () => {
    const onCommit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSearch(value, onCommit),
      { initialProps: { value: "" } }
    )

    act(() => result.current.setDraft("abc"))
    act(() => vi.advanceTimersByTime(300))
    expect(onCommit).toHaveBeenCalledWith("abc")

    rerender({ value: "abc" })
    expect(result.current.draft).toBe("abc")
  })

  it("commitNow cancels the pending timer and emits immediately", () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useDebouncedSearch("", onCommit))

    act(() => result.current.setDraft("stale"))
    act(() => result.current.commitNow(""))
    expect(onCommit).toHaveBeenCalledWith("")

    act(() => vi.advanceTimersByTime(300))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("commitNow trims the emitted value like the debounce path", () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useDebouncedSearch("", onCommit))

    act(() => result.current.commitNow("  abc  "))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith("abc")
    expect(result.current.draft).toBe("abc")

    act(() => vi.advanceTimersByTime(300))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it("cancel drops a pending emit", () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useDebouncedSearch("", onCommit))

    act(() => result.current.setDraft("stale"))
    act(() => vi.advanceTimersByTime(299))
    act(() => result.current.cancel())

    act(() => vi.advanceTimersByTime(300))
    expect(onCommit).not.toHaveBeenCalled()
  })
})
