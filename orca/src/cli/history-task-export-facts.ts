import { aggregateTaskUsageSettlements } from '../shared/task-usage-settlement-aggregate'
import type {
  HistoryTaskAgents,
  HistoryTaskBinding,
  HistoryTaskBindingState,
  HistoryTaskExport,
  HistoryTaskRun,
  HistoryTaskTokens,
  HistoryTaskWall
} from '../shared/history-task-export-types'
import type { TaskWorkspaceBinding } from '../shared/task-records-types'

export function bindingState(
  binding: TaskWorkspaceBinding,
  existing: ReadonlySet<string>
): HistoryTaskBindingState {
  if (!isExistingWorktree(binding, existing)) {
    return 'removed'
  }
  return binding.isArchived ? 'archived' : 'live'
}

function isExistingWorktree(
  binding: Pick<TaskWorkspaceBinding, 'worktreeId' | 'hostId'>,
  existing: ReadonlySet<string>
): boolean {
  return (
    existing.has(binding.worktreeId) || existing.has(`${binding.worktreeId}\u0000${binding.hostId}`)
  )
}

export function agentsOf(rows: readonly unknown[]): HistoryTaskAgents {
  return rows.length === 0
    ? { kind: 'unknown', reason: 'no_run_recorded' }
    : { kind: 'known', count: rows.length }
}

export function wallOf(
  runs: readonly Pick<HistoryTaskRun, 'startedAt' | 'endedAt'>[]
): HistoryTaskWall {
  if (runs.length === 0) {
    return { kind: 'unknown', reason: 'no_run_recorded' }
  }
  let startedAt = Number.POSITIVE_INFINITY
  let endedAt = Number.NEGATIVE_INFINITY
  let everyStart = true
  let everyEnd = true
  for (const run of runs) {
    if (run.startedAt === null) {
      everyStart = false
    } else {
      startedAt = Math.min(startedAt, run.startedAt)
    }
    if (run.endedAt === null) {
      everyEnd = false
    } else {
      endedAt = Math.max(endedAt, run.endedAt)
    }
  }
  if (everyStart && everyEnd) {
    return { kind: 'measured', startedAt, endedAt }
  }
  return {
    kind: 'partial',
    startedAt: startedAt === Number.POSITIVE_INFINITY ? null : startedAt,
    endedAt: endedAt === Number.NEGATIVE_INFINITY ? null : endedAt,
    reason: 'edge_unmeasured'
  }
}

/**
 * The task total this record can state, folded by the same shared rule the
 * workbench uses (`aggregateTaskUsageSettlements`), so one record never gets two
 * answers. Two things this surface must not claim:
 *
 * - a live workspace's figure is not in the record at all (the running app owns
 *   it), so it folds in as "not captured" like any other unrecorded workspace —
 *   the export reads the record and says so, it does not guess;
 * - an absent settlement is `unknown`, never `no_matching_session`: the record
 *   holds no measurement, and a reason token would name a scan that never ran.
 */
export function tokensOf(bindings: readonly TaskWorkspaceBinding[]): HistoryTaskTokens {
  const folded = aggregateTaskUsageSettlements(bindings.map((binding) => binding.usageSettlement))
  if (folded === null || folded.kind === 'unknown') {
    return { kind: 'unknown' }
  }
  if (folded.kind === 'unavailable') {
    return folded
  }
  return {
    kind: folded.kind === 'known' ? 'available' : 'partial',
    tokens: folded.tokens,
    estimatedCostUsd: folded.estimatedCostUsd
  }
}

export function traceOf(bindings: readonly HistoryTaskBinding[]): HistoryTaskExport['trace'] {
  if (bindings.some((binding) => binding.state === 'removed')) {
    return 'deleted'
  }
  return bindings.some((binding) => binding.state === 'archived') ? 'archived' : 'none'
}
