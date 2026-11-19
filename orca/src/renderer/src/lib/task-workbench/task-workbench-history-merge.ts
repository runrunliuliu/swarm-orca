import { taskUsageSettlementTokens } from '../../../../shared/task-records'
import type {
  TaskRecord,
  TaskRecordSession,
  TaskRecordUsageUnavailableReason,
  TaskUsageSettlement
} from '../../../../shared/task-records-types'
import type {
  SpendReason,
  TaskWorkbenchHistory,
  TaskWorkbenchHistorySession,
  TaskWorkbenchHistoryWorkspace
} from '@/components/task-workbench/task-workbench-view'

/**
 * Fold the persisted task record into the join's history (issue #36).
 *
 * The join only sees workspaces that still exist. The record is what survives a
 * deletion: the binding set, the sessions those workspaces reported, and the
 * usage figure settled before the checkout stopped being readable.
 *
 * Three rules, each of which the tests pin separately:
 * - a binding the store still knows is *not* history; presence is decided by the
 *   caller's workspace list, never by the record, so a live workspace cannot be
 *   mislabelled `Removed`;
 * - an absent settled figure stays absent (an unavailable reason), never `0`;
 * - a task with no live workspace but a record states the deleted form instead of
 *   falling back to "never started".
 */
export function mergeTaskRecordHistory(args: {
  history: TaskWorkbenchHistory
  /** Every worktree id the store still has for this repository, archived ones
   *  included. Deliberately not the task's matched set: a workspace re-linked to
   *  another task still exists, and calling it `Removed` would be a lie. */
  existingWorktreeIds: readonly string[]
  record: TaskRecord | null
}): TaskWorkbenchHistory {
  const record = args.record
  if (!record) {
    return args.history
  }
  const live = new Set(args.existingWorktreeIds)
  const removedBindings = record.bindings.filter((binding) => !live.has(binding.worktreeId))
  const archivedBindings = record.bindings.filter(
    (binding) => live.has(binding.worktreeId) && binding.isArchived
  )
  // Nothing left the store and nothing is put away: the join's answer is already
  // complete, and returning the same object keeps the panel from re-rendering on
  // every record read.
  if (removedBindings.length === 0 && archivedBindings.length === 0) {
    return args.history
  }
  const workspaces: TaskWorkbenchHistoryWorkspace[] = [
    ...archivedBindings.map((binding) => ({
      worktreeId: binding.worktreeId,
      path: binding.path,
      state: 'archived' as const,
      lastVerifiedAt: binding.lastVerifiedAt,
      hasSessions: binding.sessions.length > 0
    })),
    ...removedBindings.map((binding) => ({
      worktreeId: binding.worktreeId,
      path: binding.path,
      state: 'removed' as const,
      lastVerifiedAt: binding.lastVerifiedAt,
      hasSessions: binding.sessions.length > 0
    }))
  ]
  const sessions = removedBindings.flatMap((binding) =>
    binding.sessions.map((session): TaskWorkbenchHistorySession => ({
      key: sessionKeyOf(session),
      ...(session.provider ? { provider: session.provider } : {}),
      hasTranscriptPath: session.transcriptPath !== undefined,
      // Resume needs the checkout the session ran in; with the binding removed
      // there is nothing to resume into, so the panel must say so instead of
      // offering an action that cannot work.
      resumable: false,
      worktreeId: binding.worktreeId
    }))
  )
  const settled = aggregateSettlement(removedBindings.map((binding) => binding.usageSettlement))
  const noLiveWorkspace = record.bindings.every((binding) => !live.has(binding.worktreeId))
  const tokens = settleTokens(args.history.tokens, settled, noLiveWorkspace)

  const merged: TaskWorkbenchHistory = {
    ...args.history,
    tokens,
    tokensSource: settled === null ? args.history.tokensSource : 'settled',
    archivedWorkspaces: archivedBindings.length,
    deletedWorkspaces: removedBindings.length,
    workspaces,
    sessions,
    lastActivityAt: latestActivity(args.history.lastActivityAt, workspaces, sessions, record),
    trace: removedBindings.length > 0 ? 'deleted' : args.history.trace
  }
  if (removedBindings.length === 0) {
    return merged
  }
  // No workspace row is left to read the run facts from, so they stay unknown
  // rather than being inherited from whatever the join happened to see.
  return noLiveWorkspace ? { ...merged, agents: null, wall: { kind: 'unknown' }, runs: [] } : merged
}

/**
 * The task total for a record that spans live and removed workspaces.
 *
 * The join's figure covers the live workspaces; each settlement covers one
 * removed workspace. Adding them is the whole total only when both are known. If
 * either is unknown the total is unknown with that reason — a number computed
 * from half the task would be printed under "Total: every run".
 */
function settleTokens(
  live: TaskWorkbenchHistory['tokens'],
  settled: SettlementAggregate | null,
  noLiveWorkspace: boolean
): TaskWorkbenchHistory['tokens'] {
  if (settled === null) {
    return live
  }
  if (settled.kind === 'unavailable') {
    return { kind: 'unavailable', reason: settled.reason }
  }
  if (noLiveWorkspace) {
    return { kind: 'available', tokens: settled.tokens }
  }
  return live.kind === 'available'
    ? { kind: 'available', tokens: live.tokens + settled.tokens }
    : live
}

/** The settlement vocabulary is written in main's words (`usage_not_enabled`,
 *  `remote_usage_unavailable`); the panel speaks the spend vocabulary it already
 *  translates. One table, so the two can never drift into a badge with no word. */
const SETTLEMENT_REASON: Record<TaskRecordUsageUnavailableReason, SpendReason> = {
  usage_not_enabled: 'disabled',
  remote_usage_unavailable: 'remote_host',
  scan_failed: 'scan_failed',
  no_matching_session: 'no_matching_session',
  ambiguous_session: 'ambiguous_session'
}

/** Includes the provider: the record deliberately keeps both claims when two
 *  providers each report one id, and this key is a React list key. */
function sessionKeyOf(session: TaskRecordSession): string {
  return `${session.provider ?? 'unknown'}|${session.key}:${session.id}`
}

type SettlementAggregate =
  | { kind: 'known'; tokens: number }
  | { kind: 'unavailable'; reason: SpendReason }

/**
 * One figure for the removed workspaces. Every contributing settlement must be
 * known: a partial sum would report a task total that silently omits a workspace,
 * which reads as "this is all it spent". An unavailable settlement wins, and its
 * reason is preserved for the tooltip.
 */
function aggregateSettlement(
  settlements: readonly (TaskUsageSettlement | undefined)[]
): SettlementAggregate | null {
  if (settlements.length === 0) {
    return null
  }
  let tokens = 0
  for (const settlement of settlements) {
    if (!settlement) {
      return { kind: 'unavailable', reason: 'no_matching_session' }
    }
    if (settlement.kind === 'unavailable') {
      return { kind: 'unavailable', reason: SETTLEMENT_REASON[settlement.reason] }
    }
    const settled = taskUsageSettlementTokens(settlement)
    if (settled === null) {
      return { kind: 'unavailable', reason: 'no_matching_session' }
    }
    tokens += settled
  }
  return { kind: 'known', tokens }
}

function latestActivity(
  current: number | undefined,
  workspaces: readonly TaskWorkbenchHistoryWorkspace[],
  sessions: readonly TaskWorkbenchHistorySession[],
  record: TaskRecord
): number | undefined {
  let latest = current
  for (const workspace of workspaces) {
    if (workspace.lastVerifiedAt === null) {
      continue
    }
    latest = Math.max(latest ?? Number.NEGATIVE_INFINITY, workspace.lastVerifiedAt)
  }
  if (sessions.length > 0) {
    latest = Math.max(latest ?? Number.NEGATIVE_INFINITY, record.updatedAt)
  }
  return latest
}
