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
