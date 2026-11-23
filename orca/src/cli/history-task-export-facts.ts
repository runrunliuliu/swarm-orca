import { taskUsageSettlementTokens } from '../shared/task-records'
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

export function tokensOf(
  bindings: readonly TaskWorkspaceBinding[],
  existing: ReadonlySet<string>
): HistoryTaskTokens {
  // A live workspace's usage lives in the running app's four usage stores, not in
  // the record this command reads; its figure is unknown here, never zero.
  if (bindings.some((binding) => bindingState(binding, existing) === 'live')) {
    return { kind: 'unavailable', reason: 'no_matching_session' }
  }
  let tokens = 0
  let costUsd = 0
  let costKnown = true
  let settled = false
  for (const binding of bindings) {
    const settlement = binding.usageSettlement
    if (!settlement) {
      return { kind: 'unavailable', reason: 'no_matching_session' }
    }
    settled = true
    if (settlement.kind === 'unavailable') {
      return { kind: 'unavailable', reason: settlement.reason }
    }
    const settledTokens = taskUsageSettlementTokens(settlement)
    if (settledTokens === null) {
      return { kind: 'unavailable', reason: 'no_matching_session' }
    }
    tokens += settledTokens
    if (settlement.estimatedCostUsd === null) {
      costKnown = false
    } else {
      costUsd += settlement.estimatedCostUsd
    }
  }
  return settled
    ? { kind: 'available', tokens, estimatedCostUsd: costKnown ? costUsd : null }
    : { kind: 'unavailable', reason: 'no_matching_session' }
}

export function traceOf(bindings: readonly HistoryTaskBinding[]): HistoryTaskExport['trace'] {
  if (bindings.some((binding) => binding.state === 'removed')) {
    return 'deleted'
  }
  return bindings.some((binding) => binding.state === 'archived') ? 'archived' : 'none'
}
