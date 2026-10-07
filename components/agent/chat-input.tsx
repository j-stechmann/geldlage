"use client"

import { Square, SendHorizontal } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { CHAT_MESSAGE_MAX_CHARS } from "@/lib/agent/constants"

/**
 * Message composer (ADR-0033): Enter sends (Shift+Enter and IME
 * composition excluded), the send button swaps to stop while a turn
 * streams. maxLength enforces the route's 1–8000-char contract client-side
 * (mirrors THREAD_TITLE_MAX_INPUT_CHARS for the rename editor).
 */

interface ChatInputProps {
  disabled: boolean
  streaming: boolean
  input: string
  setInput: (v: string) => void
  onSend: () => void
  onStop: () => void
}

export function ChatInput(props: ChatInputProps) {
  return (
    <form
      className="flex items-center gap-1.5 border-t p-2"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSend()
      }}
    >
      <Input
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
        className="h-8"
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
