// @vitest-environment jsdom
/**
 * Panel-state store tests (ADR-0033): open/width state, localStorage
 * persistence, clamping. The store is module-global with a one-shot lazy
 * hydrate, so tests that depend on initial state re-import the module
 * under vi.resetModules().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { stubMatchMedia, stubLocalStorage } from "./helpers-dom"

async function freshPanelState() {
  vi.resetModules()
  return await import("@/components/agent/panel-state")
}

describe("agent panel state", () => {
  let storage: Storage
  beforeEach(() => {
    storage = stubLocalStorage()
    stubMatchMedia()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("starts closed with the default width when nothing is stored", async () => {
    const mod = await freshPanelState()
    const { result } = renderHook(() => mod.usePanelState())
    expect(result.current.open).toBe(false)
    expect(result.current.width).toBe(360)
  })

  it("togglePanel flips open and persists to localStorage", async () => {
    const mod = await freshPanelState()
    const { result } = renderHook(() => mod.usePanelState())
    act(() => mod.togglePanel())
    expect(result.current.open).toBe(true)
    expect(storage.getItem("geldlage.agent.open")).toBe("1")
    act(() => mod.togglePanel())
    expect(result.current.open).toBe(false)
    expect(storage.getItem("geldlage.agent.open")).toBe("0")
  })

  it("hydrates open/width from localStorage on first client read", async () => {
    storage.setItem("geldlage.agent.open", "1")
    storage.setItem("geldlage.agent.width", "500")
    const mod = await freshPanelState()
    const { result } = renderHook(() => mod.usePanelState())
    expect(result.current.open).toBe(true)
    expect(result.current.width).toBe(500)
  })

  it("hydrate clamps a stored width into [280, 720]", async () => {
    storage.setItem("geldlage.agent.open", "0")
    storage.setItem("geldlage.agent.width", "9999")
    const mod = await freshPanelState()
    const { result } = renderHook(() => mod.usePanelState())
    expect(result.current.width).toBe(720)
  })

  it("clampWidth rounds and clamps (ResizeHandle contract)", async () => {
    const mod = await freshPanelState()
    expect(mod.clampWidth(279.6)).toBe(280)
    expect(mod.clampWidth(360.4)).toBe(360)
    expect(mod.clampWidth(-50)).toBe(280)
    expect(mod.clampWidth(1e6)).toBe(720)
  })
})
