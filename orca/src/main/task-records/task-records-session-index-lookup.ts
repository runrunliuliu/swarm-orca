import type { AiVaultSession } from '../../shared/ai-vault-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../shared/ai-vault-session-depth'
import type {
  TaskRecordGap,
  TaskRecordSession,
  TaskRecordSnapshotSource,
  TaskRecordUsageProvider
} from '../../shared/task-records-types'
import { listAiVaultSessions } from '../ai-vault/cached-session-list'

/**
 * The degraded source of an archive snapshot (issue #53 A): when the hook server
 * no longer holds the pane that ran in this workspace, ask the agent session
 * index "which session ran at this absolute path, inside this window".
 *
 * Three things this module refuses to do, because each would manufacture the
 * "this workspace never ran anything" claim the issue exists to prevent:
 *
 * - **Treat a bounded scan as complete evidence.** `listAiVaultSessions` keeps
 *   the most recent `DEFAULT_AI_VAULT_SCAN_LIMIT` sessions and only bypasses that
 *   cap for cwd-bucketed agents (claude / pi / codebuddy). A scan that returns
 *   nothing therefore states "not in the part of the index this host scanned",
 *   which is why the gap it produces says so instead of claiming absence.
 * - **Trust `scopePaths` as the path filter.** The scope filter is a subtree
 *   (prefix) match on a bucket-encoded cwd, so a sibling under the same parent
 *   can pass it; the cwd comparison below is exact.
 * - **Guess when two sessions match.** Two candidates the window cannot separate
 *   is an `ambiguous_match` gap with the count, never a pick.
 *
 * Cost: one scan per lookup (60 s result cache, persisted parse cache). It is
 * only ever asked from the asynchronous enrichment step, never from the
 * synchronous metadata write — see `task-records-archive-snapshot.ts`.
 */

/** What one lookup is allowed to say, so a test can supply the index without the
 *  scanner child process and its filesystem roots. */
export type TaskRecordsSessionIndexLookup = (args: {
  /** The binding's absolute checkout path. */
  path: string
}) => Promise<readonly AiVaultSession[]>

export type SessionIndexSelection =
  | { kind: 'unique'; session: AiVaultSession }
  /** The scan answered, and nothing in it matched this path and window. */
  | { kind: 'none' }
  /** More than one session matched and the window could not separate them. */
  | { kind: 'ambiguous'; candidateCount: number }

/**
 * The default lookup: the same in-process scan the AI-Vault panel and the
 * `aiVault.listSessions` RPC use, scoped to one path. `unlimited` is
 * deliberately not passed: an unbounded scan of every transcript on the host is
 * not something an archive may start, and the gap text states the bound.
 */
export function createAiVaultSessionIndexLookup(): TaskRecordsSessionIndexLookup {
  return async ({ path }) => (await listAiVaultSessions({ scopePaths: [path] })).sessions
}

/** How many sessions the default lookup could have seen. Stated in the gap text
 *  so "0 hits" is never read as "0 sessions exist". */
export const SESSION_INDEX_SCAN_IS_BOUNDED = true
export const SESSION_INDEX_SCAN_LIMIT = DEFAULT_AI_VAULT_SCAN_LIMIT

/**
 * The exact-path, in-window candidate set. `scopePaths` above is only a
 * pre-filter; this is the one comparison that decides attribution.
 *
 * The window is `createdAt <= end` and `(updatedAt ?? modifiedAt) >= start`,
 * compared as parsed instants because the index stores ISO strings with offsets
 * that are not normalized. A session the index cannot date at all is kept as a
 * candidate (dropping it would be an absence the scan did not prove).
 */
export function selectSessionIndexCandidate(
  sessions: readonly AiVaultSession[],
  args: { path: string; windowStart: number; windowEnd: number }
): SessionIndexSelection {
  const target = normalizeRuntimePathForComparison(args.path)
  const matches: AiVaultSession[] = []
  for (const session of sessions) {
    // The index may report a session whose transcript names no cwd; that row
    // cannot answer "which workspace was this", so it is not a candidate.
    if (session.cwd === null || normalizeRuntimePathForComparison(session.cwd) !== target) {
      continue
    }
    const startedAt = parseIndexInstant(session.createdAt)
    const endedAt = parseIndexInstant(session.updatedAt) ?? parseIndexInstant(session.modifiedAt)
    if (startedAt !== null && startedAt > args.windowEnd) {
      continue
    }
    if (endedAt !== null && endedAt < args.windowStart) {
      continue
    }
    matches.push(session)
  }
  if (matches.length === 0) {
    return { kind: 'none' }
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', candidateCount: matches.length }
  }
  return { kind: 'unique', session: matches[0] }
}

/**
 * One session row from one index hit. The `key` is the field this id was read
 * from: for the four providers Orca attributes, the index's `sessionId` is the
 * provider's own `session_id` (that is what every one of those hooks reports), so
 * the claim matches the row the hook-server path writes for the same session. For
 * any other agent this build never observed the provider's field name, so it
 * names the index's field (`sessionId`) rather than inventing `session_id`.
 *
 * Consequence, stated rather than hidden: an agent outside the four providers
 * gets a `sessionId` claim from this path and a `session_id` claim from the hook
 * path, so the same session seen by both is two rows. They only meet when a
 * binding is archived again after a backfill, and a wrong field name would be a
 * worse fact than a duplicate row a reader can see.
 *
 * The `resumeCommand` is the index's own (`resume_command`), which is the command
 * for the session's original checkout: it is copied, never synthesized, and stays
 * absent when the index states none. The hook path has none at all — it observes a
 * pane, not a session index row — so a v1 row predating this field is normal.
 */
export function sessionRowFromIndexSession(
  session: AiVaultSession,
  args: { source: TaskRecordSnapshotSource; recordedAt: number }
): TaskRecordSession {
  const provider = usageProviderForIndexAgent(session.agent)
  const startedAt = parseIndexInstant(session.createdAt)
  const endedAt = parseIndexInstant(session.updatedAt) ?? parseIndexInstant(session.modifiedAt)
  return {
    ...(provider ? { provider } : {}),
    key: provider ? 'session_id' : 'sessionId',
    id: session.sessionId,
    transcriptPath: session.filePath,
    // The index's `agent` is the agent vocabulary the page shows, so it is
    // recorded as-is; it is not the four-value usage enum (`provider` above).
    agentType: session.agent,
    ...(session.title ? { title: session.title } : {}),
    // An empty string is the index's "no command", not a command: storing it
    // would put an executable-looking empty field on the row.
    ...(session.resumeCommand ? { resumeCommand: session.resumeCommand } : {}),
    ...(startedAt !== null ? { startedAt } : {}),
    ...(endedAt !== null ? { endedAt } : {}),
    ...(Number.isFinite(session.messageCount) && session.messageCount >= 0
      ? { messageCount: session.messageCount }
      : {}),
    source: args.source,
    recordedAt: args.recordedAt,
    firstSeenAt: args.recordedAt,
    lastSeenAt: args.recordedAt
  }
}

/**
 * The gap a lookup outcome leaves on the binding. Its identity for the merge is
 * `kind|detail`, so the text is stable per outcome (no attempt counter, no
 * timestamp, no raw error message) and a repeated archive records one row.
 */
export function sessionIndexGap(
  selection: SessionIndexSelection,
  observedAt: number
): TaskRecordGap {
  if (selection.kind === 'ambiguous') {
    return {
      kind: 'ambiguous_match',
      candidateCount: selection.candidateCount,
      observedAt,
      detail: `${selection.candidateCount} sessions match this path and the window cannot separate them; not guessed`
    }
  }
  return {
    kind: 'session_unattributable',
    candidateCount: 0,
    observedAt,
    detail: SESSION_INDEX_SCAN_IS_BOUNDED
      ? `no pane attribution and the session index has no session for this path${boundedScanNote()}`
      : 'no pane attribution and the session index has no session for this path'
  }
}

/** The sentence every "found nothing" gap must carry: the scan was bounded, so
 *  it is not evidence that nothing ran. */
export function boundedScanNote(): string {
  return ` (bounded scan: newest ${SESSION_INDEX_SCAN_LIMIT} sessions, with the scope bypass only for cwd-bucketed agents)`
}

/**
 * Which usage provider an index agent belongs to. Only the four providers Orca
 * has a usage store for, and only under the exact name the bucket is keyed by —
 * this is a lookup of a known table, not an inference from an unknown agent.
 * Everything else (pi, cursor, gemini, …) stays `undefined`, which the record
 * stores as "unknown provider" instead of a bucket that was never measured.
 */
const USAGE_PROVIDER_BY_INDEX_AGENT: Partial<Record<string, TaskRecordUsageProvider>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  muse: 'muse'
}

function usageProviderForIndexAgent(agent: string): TaskRecordUsageProvider | undefined {
  return USAGE_PROVIDER_BY_INDEX_AGENT[agent]
}

function parseIndexInstant(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  // An unparseable instant is not evidence about the window, so it is treated as
  // "this row does not date itself" rather than as 0 (which would look ancient).
  return Number.isFinite(parsed) ? parsed : null
}
