import { apiFetch } from "@/lib/api-fetch"
import type {
  ThreadDetail,
  ThreadSummary,
  UserRow,
} from "@/components/agent/types"

/**
 * Typed API access for the agent panel (ADR-0033): every server call with
 * its query key and invalidation helpers in one module, so components
 * orchestrate instead of hand-rolling fetch/toast/error plumbing.
 */

export const THREADS_KEY = ["agent-threads"] as const
export const MESSAGES_KEY = (threadId: string) =>
  ["agent-messages", threadId] as const
export const USERS_KEY = ["agent-users"] as const

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Non-OK JSON (e.g. the invited-preview 404) must surface as a query
    // ERROR, not as success data cast to T — otherwise React Query never
    // enters the error state and the UI renders the error body as a
    // message list.
    const body = (await res.json().catch(() => null)) as {
      error?: string
    } | null
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/** Typed fetch failure for React Query error states. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    serverError: string
  ) {
    super(`API ${status}: ${serverError}`)
    this.name = "ApiError"
  }
}

/** Error message from a JSON error body, or a fallback. */
export async function errorMessage(
  res: Response,
  fallback: string
): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    message?: string
  } | null
  return body?.message ?? fallback
}

export async function fetchThreads(): Promise<{ threads: ThreadSummary[] }> {
  return readJson(await apiFetch("/api/agent/threads"))
}

export async function fetchThreadDetail(
  threadId: string
): Promise<ThreadDetail> {
  return readJson(await apiFetch(`/api/agent/threads/${threadId}/messages`))
}

/** Only fetched while the invite dialog is open. */
export async function fetchUsers(): Promise<{ users: UserRow[] }> {
  return readJson(await apiFetch("/api/users"))
}

export async function createThread(): Promise<ThreadSummary | null> {
  const res = await apiFetch("/api/agent/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })
  if (!res.ok) return null
  const { thread } = await readJson<{ thread: ThreadSummary }>(res)
  return thread
}

export async function sendTurn(
  threadId: string,
  content: string,
  signal: AbortSignal
): Promise<Response> {
  return apiFetch(`/api/agent/threads/${threadId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  })
}

export async function renameThread(
  threadId: string,
  title: string
): Promise<boolean> {
  const res = await apiFetch(`/api/agent/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  return res.ok
}

export async function invite(
  threadId: string,
  userIds: number[]
): Promise<number | null> {
  const res = await apiFetch(`/api/agent/threads/${threadId}/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userIds }),
  })
  if (!res.ok) return null
  const { invited } = await readJson<{ invited: number }>(res)
  return invited
}

/**
 * DELETE /threads/[id] is role-polymorphic (owner deletes, member leaves,
 * invited declines) — one client call for all three.
 */
export async function deleteOrLeaveThread(threadId: string): Promise<boolean> {
  const res = await apiFetch(`/api/agent/threads/${threadId}`, {
    method: "DELETE",
  })
  return res.ok
}

export async function joinThread(threadId: string): Promise<boolean> {
  const res = await apiFetch(`/api/agent/threads/${threadId}/join`, {
    method: "POST",
  })
  return res.ok
}

/** Post-mutation cache refresh: threads list, plus a thread's messages. */
export function invalidate(
  queryClient: {
    invalidateQueries: (opts: { queryKey: readonly unknown[] }) => Promise<void>
  },
  threadId?: string
): void {
  const jobs: Array<Promise<void>> = [
    queryClient.invalidateQueries({ queryKey: THREADS_KEY }),
  ]
  if (threadId) {
    jobs.push(
      queryClient.invalidateQueries({ queryKey: MESSAGES_KEY(threadId) })
    )
  }
  for (const job of jobs) job.catch(() => undefined)
}
