import { eq } from "drizzle-orm"
import {
  DEFAULT_THREAD_TITLE,
  THREAD_TITLE_MAX_INPUT_CHARS,
  THREAD_TITLE_MAX_CHARS,
} from "@/lib/agent/constants"
import { getThread } from "@/lib/agent/store/threads"
import { streamAgentChat } from "@/lib/agent/chat-client"
import { titlePrompt } from "@/lib/agent/system-prompt"
import { getDb } from "@/lib/db"
import { chatThreads } from "@/lib/db/schema"

/**
 * AI thread titling (ADR-0033): after the first user turn completes, ask
 * the model for a short thread title via the same chat endpoint (no
 * tools). The thread keeps the default title until the AI answer lands;
 * on failure the substring fallback applies (fallbackTitle). A user-
 * chosen name is never overwritten — every path guards on the default
 * title at call time AND on write.
 */

/**
 * Called after the first turn's done event: asks the model for a title
 * and writes it, or falls back to the substring title. Runs detached
 * (void) — the chat SSE response is already fully enqueued; the single
 * llama-server slot is free then.
 */
export function maybeAutoTitle(
  threadId: string,
  firstUserMessage: string
): void {
  void generateTitle(threadId, firstUserMessage).catch((err) => {
    console.warn(
      `[agent] auto-title failed for ${threadId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    fallbackTitle(threadId, firstUserMessage)
  })
}

async function generateTitle(
  threadId: string,
  firstUserMessage: string
): Promise<void> {
  // Bail before any LLM call when the default title is already gone
  // (renamed while the turn ran) — the user's name stands.
  const thread = getThread(threadId)
  if (!thread || thread.title !== DEFAULT_THREAD_TITLE) return

  const answer = await completeOneShot(titlePrompt(firstUserMessage))
  const title = sanitizeTitle(answer)
  if (!title) {
    console.warn(`[agent] auto-title produced no usable title for ${threadId}`)
    fallbackTitle(threadId, firstUserMessage)
    return
  }
  // Re-check the default-title guard on write — between the first check
  // and now the user may have renamed (never clobber a user-chosen name).
  writeTitleIfDefault(threadId, title)
}

/** Substring fallback: first 24 chars, single-line (the original rule). */
function fallbackTitle(threadId: string, firstUserMessage: string): void {
  const singleLine = firstUserMessage.replace(/\s+/g, " ").trim()
  const title =
    singleLine.length > THREAD_TITLE_MAX_CHARS
      ? singleLine.slice(0, THREAD_TITLE_MAX_CHARS) + "…"
      : singleLine
  if (!title) return
  writeTitleIfDefault(threadId, title)
}

/**
 * Writes the title only while the thread still wears the default — the
 * one guard both the AI path and the fallback share.
 */
function writeTitleIfDefault(threadId: string, title: string): void {
  const current = getThread(threadId)
  if (!current || current.title !== DEFAULT_THREAD_TITLE) return
  getDb()
    .update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId))
    .run()
}

/** One completion with tools disabled; joins the content deltas. */
async function completeOneShot(prompt: string): Promise<string> {
  let content = ""
  for await (const ev of streamAgentChat([{ role: "user", content: prompt }], {
    tools: [],
  })) {
    if (ev.type === "content") content += ev.text
  }
  return content
}

/**
 * Strips quotes/whitespace noise, enforces the 80-char input cap; returns
 * "" when nothing usable remains (caller keeps the fallback).
 */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw
    .replace(/["'“”„«»]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, THREAD_TITLE_MAX_INPUT_CHARS)
  const lower = cleaned.toLowerCase()
  if (
    cleaned === "" ||
    cleaned === DEFAULT_THREAD_TITLE ||
    lower === "unbenannt" ||
    lower === "titel"
  ) {
    return ""
  }
  return cleaned
}
