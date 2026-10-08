/**
 * Client-side DTOs mirroring the server contract of app/api/agent/** and
 * app/api/users (ADR-0033). Kept in one place so a server response change
 * surfaces as a single-file type edit — previously these were inlined in
 * the monolithic chat component and drifted (a field the server never
 * sends sat in ThreadSummary).
 */

export type ThreadRole = "owner" | "member" | "invited"

export interface ThreadSummary {
  id: string
  title: string
  role: ThreadRole
  updatedAt: string
}

export interface StoredMessage {
  id: string
  userId: number | null
  role: "user" | "assistant" | "tool"
  content: string
  reasoning: string | null
  toolName: string | null
  toolArgs: string | null
  createdAt: string
  threadSeq: number
}

export interface Member {
  userId: number
  name: string
  email: string
  state: string
}

export interface ThreadDetail {
  thread: {
    id: string
    title: string
    ownerId: number
    ownerName: string
    createdAt: string
    updatedAt: string
  }
  role: "owner" | "member"
  members: Member[]
  messages: StoredMessage[]
}

/** One streamed tool round in the UI: a call (args) and its result. */
export interface ToolEvent {
  kind: "tool_call" | "tool_result"
  name: string
  payload: string
}

export interface UserRow {
  id: number
  name: string
  email: string
}
