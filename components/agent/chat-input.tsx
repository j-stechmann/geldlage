"use client"

import { useEffect, useLayoutEffect, useRef } from "react"
import { Square, SendHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CHAT_MESSAGE_MAX_CHARS } from "@/lib/agent/constants"

// Measure before paint (the textarea must never paint a new line clipped
// for one frame); on the server the plain effect is a no-op but avoids the
// SSR useLayoutEffect warning.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

/**
 * Message composer (ADR-0033): Enter sends; Shift+Enter inserts a newline
 * and IME composition is excluded, the send button swaps to stop while a
 * turn streams. The textarea grows with its content up to max-h-40 (then
 * scrolls) so a long or multi-line draft stays visible instead of
 * disappearing past the single-line edge. maxLength enforces the route's
 * char contract client-side (mirrors THREAD_TITLE_MAX_INPUT_CHARS for the
 * rename editor).
 */

interface ChatInputProps {
  disabled: boolean
  streaming: boolean
  input: string
  setInput: (v: string) => void
  onSend: () => void
  onStop: () => void
}

/**
 * Auto-grow: reset to `auto` first so deleting text shrinks the box too,
 * then match the content height. The CSS max-height caps the inline height
 * and turns the overflow into a scrollbar. `border-box` sizing: scrollHeight
 * excludes the border while the inline height includes it, so add it back —
 * otherwise a fitting draft overflows by the border width and overflow-y-auto
 * shows a scrollbar even when nothing is cut.
 */
function growTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto"
  const border = el.offsetHeight - el.clientHeight
  el.style.height = `${el.scrollHeight + border}px`
}

export function ChatInput(props: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useIsoLayoutEffect(() => {
    if (textareaRef.current) growTextarea(textareaRef.current)
  }, [props.input])

  // The dock is resizable (and the window cap re-flows it): a width change
  // re-wraps the draft, so re-measure even though `input` did not change.
  // Compare the border-box width — the height writes above can toggle the
  // scrollbar and with it clientWidth; watching that would feed back into
  // another grow and oscillate at the max-height boundary. Set up once:
  // input changes only need the measure effect above.
  useIsoLayoutEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === "undefined") return

    let lastWidth = el.offsetWidth
    const observer = new ResizeObserver(() => {
      const width = el.offsetWidth
      if (width === lastWidth) return
      lastWidth = width
      growTextarea(el)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <form
      className="flex items-end gap-1.5 border-t p-2"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSend()
      }}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        autoFocus
        value={props.input}
        placeholder="Nachricht…"
        disabled={props.disabled}
        maxLength={CHAT_MESSAGE_MAX_CHARS}
        onChange={(e) => props.setInput(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !(
              e.nativeEvent instanceof KeyboardEvent &&
              e.nativeEvent.isComposing
            )
          ) {
            e.preventDefault()
            props.onSend()
          }
        }}
        className="max-h-40 min-h-8 w-full min-w-0 resize-none overflow-y-auto rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
      />
      {props.streaming ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Stoppen"
          onClick={props.onStop}
        >
          <Square className="size-4" />
        </Button>
      ) : (
        <Button
          type="submit"
          size="icon"
          aria-label="Senden"
          disabled={props.disabled || !props.input.trim()}
        >
          <SendHorizontal className="size-4" />
        </Button>
      )}
    </form>
  )
}
