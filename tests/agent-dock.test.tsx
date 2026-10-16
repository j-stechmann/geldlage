// @vitest-environment jsdom
/**
 * AgentDock frame tests (ADR-0033): the resize handle's keyboard contract
 * (WAI-ARIA separator pattern). Pointer-drag math and store persistence are
 * covered by tests/agent-panel-state.test.tsx; the chat internals the dock
 * hosts are covered by tests/agent-panel-ui.test.tsx.
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
} from "./helpers-dom"

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
    renderWithQuery(createElement(AgentDock))
    const handle = screen.getByRole("separator")
    fireEvent.keyDown(handle, { key: "End" })
    expect(storage.getItem("geldlage.agent.width")).toBe("720")
    fireEvent.keyDown(handle, { key: "Home" })
    expect(storage.getItem("geldlage.agent.width")).toBe("280")
  })

  it("leaves the width untouched on unrelated keys", () => {
    renderWithQuery(createElement(AgentDock))
    const handle = screen.getByRole("separator")
    fireEvent.keyDown(handle, { key: "a" })
    expect(storage.getItem("geldlage.agent.width")).toBe("360")
  })
})
