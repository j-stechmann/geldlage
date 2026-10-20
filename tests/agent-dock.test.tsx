// @vitest-environment jsdom
/**
 * AgentDock frame tests (ADR-0033): the resize handle's keyboard contract
 * (WAI-ARIA separator pattern) and the drag's persistence timing. Store
 * basics (hydrate/clamp/toggle persistence) are covered by
 * tests/agent-panel-state.test.tsx; the chat internals the dock hosts
 * are covered by tests/agent-panel-ui.test.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, screen, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import { AgentDock } from "@/components/agent/agent-dock"
import { setPanelState } from "@/components/agent/panel-state"
import {
  renderWithQuery,
  stubFetch,
  stubLocalStorage,
  stubMatchMedia,
  stubResizeObserver,
  stubScrollTo,
  stubSetPointerCapture,
} from "./helpers-dom"

/** jsdom's fixed 1024px viewport would fight the dock's viewport cap:
 * swap in an own innerWidth and restore jsdom's original descriptor in
 * afterEach (its getter is an own property — deleting it would break
 * every later test). */
const jsdomViewport = Object.getOwnPropertyDescriptor(window, "innerWidth")
let viewportOverride = false

function setViewportWidth(width: number) {
  viewportOverride = true
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  })
}

describe("agent dock resize handle", () => {
  let storage: Storage
  beforeEach(() => {
    storage = stubLocalStorage()
    stubMatchMedia(true) // desktop: docked <aside>, not the mobile overlay
    stubResizeObserver()
    stubScrollTo()
    // AgentChat mounts inside the open dock: only the threads list is
    // fetched (no active thread → no detail query)
    stubFetch([
      {
        url: "/api/agent/threads",
        method: "GET",
        json: { threads: [] },
      },
    ])
    // panel-state is module-global and persists across the file's tests:
    // pin the default width so every test starts at a known baseline
    act(() => setPanelState({ open: true, width: 360 }))
  })

  afterEach(() => {
    if (viewportOverride && jsdomViewport) {
      viewportOverride = false
      Object.defineProperty(window, "innerWidth", jsdomViewport)
    }
    vi.unstubAllGlobals()
  })

  it("is a focusable separator (not aria-hidden)", () => {
    renderWithQuery(createElement(AgentDock))
    const handle = screen.getByRole("separator", {
      name: "Breite des Chats ändern",
    })
    expect(handle).toHaveAttribute("tabindex", "0")
  })

  it("ArrowLeft widens, ArrowRight narrows by the step", () => {
    renderWithQuery(createElement(AgentDock))
    const handle = screen.getByRole("separator")
    // default width 360; the handle sits on the LEFT edge, so moving left
    // (like dragging left) widens the dock
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(storage.getItem("geldlage.agent.width")).toBe("376")
    expect(screen.getByRole("complementary")).toHaveStyle({ width: "376px" })
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(storage.getItem("geldlage.agent.width")).toBe("360")
  })

  it("Home/End clamp to the width bounds", () => {
    // wide viewport (jsdom default 1024 would cap End at 100vw-320px):
    // on a window large enough for the absolute bounds End reaches 720
    setViewportWidth(1920)
    renderWithQuery(createElement(AgentDock))
    const handle = screen.getByRole("separator")
    fireEvent.keyDown(handle, { key: "End" })
    expect(storage.getItem("geldlage.agent.width")).toBe("720")
    fireEvent.keyDown(handle, { key: "Home" })
    expect(storage.getItem("geldlage.agent.width")).toBe("280")
  })

  it("clamps drag and End to the viewport (page keeps 320px beside the dock)", () => {
    // Regression: the persisted width only knew the absolute 280–720
    // bounds, so a 720px dock on a small window (or a drag past the
    // window edge) squeezed the page to a sliver and the flex row
    // overflowed horizontally. The resizable bounds now include the
    // viewport cap viewport-320.
    setViewportWidth(900) // cap = 900 - 320 = 580
    stubSetPointerCapture()
    renderWithQuery(createElement(AgentDock))
    const aside = screen.getByRole("complementary")
    expect(aside).toHaveClass("max-w-[calc(100vw-320px)]")
    aside.getBoundingClientRect = () => ({ width: 360 }) as DOMRect
    const handle = screen.getByRole("separator")

    // drag far past the window: preview clamps at the cap
    fireEvent.pointerDown(handle, { clientX: 600, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 })
    expect(aside).toHaveStyle({ width: "580px" })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(storage.getItem("geldlage.agent.width")).toBe("580")

    // End asks for the widest allowed: the viewport cap, not 720
    fireEvent.keyDown(handle, { key: "End" })
    expect(storage.getItem("geldlage.agent.width")).toBe("580")
  })

  it("leaves the width untouched on unrelated keys", () => {
    renderWithQuery(createElement(AgentDock))
    const handle = screen.getByRole("separator")
    fireEvent.keyDown(handle, { key: "a" })
    expect(storage.getItem("geldlage.agent.width")).toBe("360")
  })

  it("persists the dragged width once on pointerup, not per move", () => {
    // Regression: every pointermove used to write the width to
    // localStorage synchronously (dozens of writes per drag); the moves
    // now only preview the live width and the release persists it.
    stubSetPointerCapture()
    renderWithQuery(createElement(AgentDock))
    const aside = screen.getByRole("complementary")
    // jsdom's rects are all-zero: anchor the drag at a realistic width
    aside.getBoundingClientRect = () => ({ width: 360 }) as DOMRect
    const handle = screen.getByRole("separator")

    fireEvent.pointerDown(handle, { clientX: 600, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 560, pointerId: 1 })
    // the live width follows the drag (in-memory preview re-renders)…
    expect(aside).toHaveStyle({ width: "400px" })
    // …but nothing hit localStorage yet
    expect(storage.getItem("geldlage.agent.width")).toBe("360")
    fireEvent.pointerMove(handle, { clientX: 520, pointerId: 1 })
    expect(aside).toHaveStyle({ width: "440px" })
    expect(storage.getItem("geldlage.agent.width")).toBe("360")

    // pointer capture funnels the release to the handle: one write
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(storage.getItem("geldlage.agent.width")).toBe("440")
  })

  it("keeps the same root element across the md breakpoint (no remount)", () => {
    // Regression: the dock used to swap <div> ↔ <aside> at 768px, which
    // unmounted AgentChat mid-turn and aborted the in-flight request
    // through useAgentTurn's unmount cleanup. matchMedia with a live
    // `matches` getter + a fireable change listener simulates the
    // crossing; the root <aside> must keep its DOM identity and only
    // switch classes/width in place.
    let desktop = true
    let changeListener: (() => void) | null = null
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation(() => ({
        get matches() {
          return desktop
        },
        media: "(min-width: 768px)",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: (_: string, cb: () => void) => {
          changeListener = cb
        },
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    )
    renderWithQuery(createElement(AgentDock))
    const aside = screen.getByRole("complementary")
    expect(aside).toHaveClass("sticky")
    expect(aside).toHaveStyle({ width: "360px" })

    desktop = false
    act(() => changeListener?.())

    // same DOM node — React reconciled the branch in place
    expect(screen.getByRole("complementary")).toBe(aside)
    expect(aside).toHaveClass("fixed")
    // the desktop width style is gone; the resize handle unmounted
    expect(aside).not.toHaveStyle({ width: "360px" })
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
  })
})
