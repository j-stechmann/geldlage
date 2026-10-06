/**
 * Shared SSE plumbing for both llama-server chat consumers: the label path
 * (lib/llm/client.ts, ADR-0016 grammar-constrained JSON) and the agent chat
 * path (lib/agent/*, ADR-0033 native tool calls). Extracted from client.ts
 * in ADR-0033. Frame semantics are the ORIGINAL readSse ones — separators
 * \r\n\r\n | \n\n | \r\r (plus final frame without a trailing blank line),
 * multi-line data joined with \n, [DONE]/comments dropped — tested by the
 * existing llm-client suite.
 */

/**
 * Blank-line separators that terminate one frame. The regex-based drain()
 * this was extracted from matched every separator permutation
 * (`(?:\r\n|\r|\n)((?:\r\n|\r|\n)+)`); a proxy that reframes the body
 * CRLF-style must not fold the whole stream into one unparseable frame.
 */
const SSE_FRAME_SEPARATOR = /(?:\r\n|\r|\n)((?:\r\n|\r|\n)+)/

interface SseFrame {
  data: string
  eventName: string | null
}

/**
 * Generator over parsed SSE frames of a response body. Frame reassembly is
 * buffer-based: pop every complete frame (terminated by a blank line), emit,
 * repeat — the same regex drain() the label path used, structured so the
 * same code also serves the consumer folds below ([DONE]/comments/event-
 * names handled once, here).
 *
 * The reader never cancels mid-body: consumer-loops drive it to done, and
 * releaseLock in the finally block covers early consumer exits (return/
 * throw) — the socket then tears down with the next read.
 */
export async function* sseGenerator(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  // local decoder: { stream: true } keeps partial UTF-8 sequences pending
  // across reads — state that must not interleave with sanitizeLabel's
  // module-wide decoder
  const decoder = new TextDecoder()
  let buffer = ""
  const yielded: SseFrame[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = drain(buffer, (frame) => yielded.push(frame))
      for (const frame of yielded) yield frame
      yielded.length = 0
    }
    // flush any pending partial bytes, then a final frame without a
    // trailing blank line is still valid SSE
    buffer += decoder.decode()
    buffer = drain(buffer, (frame) => yielded.push(frame))
    for (const frame of yielded) yield frame
    yielded.length = 0
    if (buffer.trim()) {
      const frame = extractFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Pops every complete frame (terminated by a blank line) off the buffer,
 * passing each through emit. Returns the remaining partial buffer.
 */
function drain(buffer: string, emit: (frame: SseFrame) => void): string {
  let rest = buffer
  let sep: RegExpExecArray | null
  while ((sep = SSE_FRAME_SEPARATOR.exec(rest))) {
    const rawFrame = rest.slice(0, sep.index)
    rest = rest.slice(sep.index + sep[0].length)
    const frame = extractFrame(rawFrame)
    if (frame) emit(frame)
  }
  return rest
}

/**
 * Extracts one frame's data (multi-line data joined with \n) and event
 * name. `data: [DONE]`, empty data and comment/id:/retry: lines are
 * dropped (the event name is parsed for the agent route's dispatcher;
 * llama-server never sends named events today).
 */
function extractFrame(rawFrame: string): SseFrame | null {
  const dataLines: string[] = []
  let eventName: string | null = null
  for (const line of rawFrame.split(/\r\n|\r|\n/)) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trimStart()
      if (data && data !== "[DONE]") dataLines.push(data)
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || null
    }
  }
  const data = dataLines.join("\n")
  return data ? { data, eventName } : null
}

/**
 * Reads an SSE body into parsed `data:` frame strings. Used by the label
 * path's readContent (batch shape: collect everything, then fold).
 */
export async function collectSse(res: Response): Promise<string[]> {
  const body = res.body
  if (!body) return []
  const frames: string[] = []
  for await (const frame of sseGenerator(body)) {
    frames.push(frame.data)
  }
  return frames
}

/**
 * AbortSignal.timeout() rejects with a DOMException named "TimeoutError"
 * (Node ≥17.3 and Bun), and reads of an aborted body reject the same way.
 * isTimeoutError answers for the whole module so both consumers classify
 * identically.
 */
export function isTimeoutError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    err instanceof SseTimeoutError
  )
}

/** Thrown when an SSE body stalls or the fetch deadline hits. */
export class SseTimeoutError extends Error {
  constructor(ms: number) {
    super(`SSE body timed out after ${ms}ms`)
    this.name = "SseTimeoutError"
  }
}
