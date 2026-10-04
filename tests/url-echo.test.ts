import { describe, it, expect, beforeEach, vi } from "vitest"
import { UrlEchoRegistry } from "@/lib/url-echo"

const TTL = 10_000

describe("UrlEchoRegistry", () => {
  let registry: UrlEchoRegistry

  beforeEach(() => {
    registry = new UrlEchoRegistry(TTL)
  })

  it("classifies a committed echo as own and consumes it", () => {
    registry.add("q=foo", "", 1000)
    expect(registry.consume("q=foo")).toBe("own")
    // consumed: a later external navigation to the same URL is adopted
    expect(registry.consume("q=foo")).toBe("external")
  })

  it("classifies unknown URL changes as external", () => {
    registry.add("q=foo", "", 1000)
    expect(registry.consume("q=bar")).toBe("external")
  })

  it("does not register a redundant commit matching the current URL", () => {
    registry.add("q=foo", "q=foo", 1000)
    expect(registry.consume("q=foo")).toBe("external")
  })

  it("drops queued echoes newer than the consumed one", () => {
    registry.add("q=a", "", 1000)
    registry.add("q=b", "q=a", 2000)
    // the q=a commit lands after q=b was already set: the later local
    // state already reflects q=b, so its pending echo must not swallow
    // a future back/forward navigation to q=b
    expect(registry.consume("q=a")).toBe("own")
    expect(registry.consume("q=b")).toBe("external")
  })

  it("keeps older pending echoes when consuming", () => {
    registry.add("q=a", "", 1000)
    registry.add("q=b", "q=a", 2000)
    // the newest navigation commits first: the older queued echo stays
    expect(registry.consume("q=b")).toBe("own")
    expect(registry.consume("q=a")).toBe("own")
  })

  it("evicts echoes older than the TTL on add", () => {
    registry.add("q=old", "", 1000)
    vi.spyOn(Date, "now").mockReturnValue(1000 + TTL + 1)
    try {
      registry.add("q=new", "q=old")
      expect(registry.consume("q=old")).toBe("external")
      expect(registry.consume("q=new")).toBe("own")
    } finally {
      vi.spyOn(Date, "now").mockRestore()
    }
  })

  it("keeps pending echoes within the TTL on add", () => {
    registry.add("q=old", "", 1000)
    vi.spyOn(Date, "now").mockReturnValue(1000 + TTL - 1)
    try {
      registry.add("q=new", "q=old")
      // q=old is still pending (age < TTL): the add must not evict it
      expect(registry.consume("q=new")).toBe("own")
      expect(registry.consume("q=old")).toBe("own")
    } finally {
      vi.spyOn(Date, "now").mockRestore()
    }
  })
})
