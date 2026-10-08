/**
 * Persistence helpers for agent chat threads (ADR-0033). All synchronous
 * via getDb() (better-sqlite3): the chat routes run inside one request
 * handler and there is no writer concurrency worth awaiting. Roles: the
 * thread creator (chatThreads.userId) is the "owner" — the only one who
 * may invite/rename/delete; everyone else goes through chatThreadMembers
 * with state invited → joined.
 *
 * Barrel module: the implementation is split by concern (lib/agent/
 * store/*) and re-exported here so the route/test import surface stays
 * stable.
 */

export {
  appendMessage,
  listMessages,
  listRecentMessages,
  DEFAULT_THREAD_TITLE,
} from "@/lib/agent/store/messages"

export {
  listMembers,
  inviteMembers,
  removeMember,
  setMemberState,
  type ThreadMember,
} from "@/lib/agent/store/members"

export {
  createThread,
  getThread,
  listThreadsForUser,
  touchThread,
  renameThread,
  deleteThread,
} from "@/lib/agent/store/threads"

export {
  roleOf,
  rankOf,
  type ThreadRole,
} from "@/lib/agent/store/thread-access"
