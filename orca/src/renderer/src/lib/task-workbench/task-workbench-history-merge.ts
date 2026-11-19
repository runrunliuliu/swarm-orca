import type { TaskRunHistoryRecord } from '../../../../shared/task-run-history'
import type { TaskWorkbenchHistory } from '@/components/task-workbench/task-workbench-view'

/**
 * Fold the persisted worktree → task ledger into the join's history (issue #31
 * S2). The join only sees worktrees that still exist; the ledger is what proves
 * a task ran after its workspace was deleted.
 *
 * Rules:
 * - no deleted record → the join's answer is unchanged;
 * - an archived workspace is still on disk, so its "content is still here" note
 *   wins and the deleted count is only carried as data;
 * - no live or archived workspace left → the deleted form, with `agents: null`
 *   and an unavailable token figure. S2 stores the mapping, not agent runs, so
 *   this is unknown rather than a fabricated 0.
 */
export function mergeTaskRunHistory(args: {
  history: TaskWorkbenchHistory
  /** Active + archived worktrees that still exist. */
  worktreeCount: number
  records: readonly TaskRunHistoryRecord[]
}): TaskWorkbenchHistory {
  const deleted = args.records.filter((record) => record.state === 'deleted')
  if (deleted.length === 0) {
    return args.history
  }
  if (args.worktreeCount > 0) {
    return { ...args.history, deletedWorkspaces: deleted.length }
  }
  return {
    ...args.history,
    agents: null,
    wall: { kind: 'unknown' },
    tokens: { kind: 'unavailable', reason: 'unattributed' },
    archivedWorkspaces: 0,
    deletedWorkspaces: deleted.length,
    lastActivityAt: undefined,
    trace: 'deleted',
    runs: []
  }
}
