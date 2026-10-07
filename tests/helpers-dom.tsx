/**
 * DOM test helpers for the agent panel components (ADR-0033): React
 * Query wrapper and fetch stubbing with scriptable JSON/SSE responses.
 * Used with the per-file `@vitest-environment jsdom` docblock.
 */
import React from "react"
import { render, type RenderOptions } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { vi, afterEach, beforeAll } from "vitest"
import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"

// vitest runs without globals:true, so RTL's auto-cleanup (which hooks
// afterEach via the global) does not engage — register it explicitly so
// every test file importing this helper unmounts between tests.
afterEach(() => {
  cleanup()
})

// RTL's act() environment flag (React 18+: act warnings and proper
// batching are only active when this global is set).
beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

export function renderWithQuery(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
  const utils = render(ui, {
    wrapper: ({ children }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children
      ),
    ...options,
  })
  return { queryClient, ...utils }
}

/** One scripted fetch response. */
export interface MockResponse {
  /** Exact pathname match, or a RegExp tested against the pathname. */
  url: string | RegExp
  method?: string
  status?: number
  /** JSON body shortcut. */
  json?: unknown
  /** SSE body shortcut (Content-Type text/event-stream). */
  sse?: string
  raw?: string
  contentType?: string
  /** Consumed by exactly one matching call (earlier entries win). */
  once?: boolean
}

export function stubFetch(responses: MockResponse[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const remaining = responses.map((r) => ({ ...r }))
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const path = url.startsWith("http")
        ? new URL(url).pathname
        : url.split("?")[0]
      const method = (init?.method ?? "GET").toUpperCase()
      // first unconsumed match in order: `once` entries serve exactly one
      // call (e.g. the post-done refetch differing from the initial fetch)
      const matchIdx = remaining.findIndex((r) => matches(r, path, method))
      if (matchIdx === -1) {
        throw new TypeError(
          `fetch mocked out — no script for ${path} ${method}`
        )
      }
      const match = remaining[matchIdx]
      if (match.once) remaining.splice(matchIdx, 1)
      const status = match.status ?? 200
      const contentType =
        match.contentType ??
        (match.sse !== undefined ? "text/event-stream" : "application/json")
      const body =
        match.sse ??
        (match.json !== undefined
          ? JSON.stringify(match.json)
          : (match.raw ?? ""))
      return new Response(body, {
        status,
        headers: { "Content-Type": contentType },
      })
    }
  )
  vi.stubGlobal("fetch", fetchMock)
  return { calls, fetchMock }
}

function matches(r: MockResponse, path: string, method: string): boolean {
  const urlMatch = typeof r.url === "string" ? path === r.url : r.url.test(path)
  const methodMatch = !r.method || method === r.method.toUpperCase()
  return urlMatch && methodMatch
}

/**
 * Builds an SSE response body string from named events (the server's
 * frame format: `event: <n>\ndata: <json>\n\n`).
 */
export function sseFrames(
  events: Array<{ event: string; data: unknown }>
): string {
  return events
    .map(
      ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    )
    .join("")
}

/** jsdom lacks matchMedia (panel-state hydration + dock queries). */
export function stubMatchMedia(matches = false) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  )
}

/**
 * Node ≥26 defines a global localStorage getter stub on globalThis
 * (undefined unless --localstorage-file is passed), which makes vitest's
 * jsdom global-population drop jsdom's working storage — restore an
 * in-memory Web Storage for the tests that need it.
 */
export function stubLocalStorage() {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  }
  vi.stubGlobal("localStorage", storage)
  return storage
}

/** jsdom lacks Element.scrollTo. */
export function stubScrollTo() {
  Element.prototype.scrollTo = vi.fn()
}

/** jsdom lacks ResizeObserver (stream-follow pinning in message-list). */
export function stubResizeObserver() {
  class FakeResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
}
