/**
 * Agent-wide constants (ADR-0033). Dependency-free by design — imported
 * by the DB schema (drizzle default + hand-written DDL) and the store
 * alike, so the default thread title is defined exactly once.
 */

/** Threads wear this title until the first user turn (or a rename). */
export const DEFAULT_THREAD_TITLE = "Neuer Chat"

/** Auto-title fallback cap: keeps sidebar rows single-line. */
export const THREAD_TITLE_MAX_CHARS = 24

/** Thread rename cap (client input + PATCH validation agree on this). */
export const THREAD_TITLE_MAX_INPUT_CHARS = 80

/** Per-message char cap for chat input (client + route validation). */
export const CHAT_MESSAGE_MAX_CHARS = 8000

/**
 * Persisted when the model streamed only a reasoning trace and no prose
 * (a reasoning-only `done`). Prevents an empty assistant bubble; the
 * collapsible "Denkprozess" stays, the body states the miss.
 */
export const AGENT_NO_ANSWER_TEXT = "(Das Modell hat keine Antwort formuliert.)"
