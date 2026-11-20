import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  persistTaskRecords,
  recordTaskRecordsForWorktreeMeta,
  settleTaskRecordsBeforeRemoval
} from './task-records-persistence'
import type { TaskRecordsRuntime } from './task-records-persistence'
import type { WriteSchedulingOperations } from './write-scheduling'

/**
 * The two points where worktree metadata tells the task ledger something (issue
 * #36): a metadata write may bind or archive a task, and a removal must settle
 * the workspace's usage before the row that names it is dropped.
 *
 * Kept out of `metadata-lineage-operations.ts` so that file stays inside its line
 * budget, and reading the metadata from the store keeps each call site to one
 * line instead of repeating a persist-and-schedule pair.
 */
export type TaskRecordsMetadataContext = {
  runtime: TaskRecordsRuntime
  scheduling: WriteSchedulingOperations
}

export function recordTaskRecordsForWorktree(
  context: TaskRecordsMetadataContext,
  worktreeId: string,
  /** The row the caller just wrote. A host-qualified write must pass it: the
   *  legacy `worktreeMeta[worktreeId]` projection belongs to the *first* owner,
   *  so reading it back would record another host's links under this host. */
  meta?: WorktreeMeta
): void {
  const resolved = meta ?? context.runtime.state.worktreeMeta?.[worktreeId]
  if (!resolved) {
    return
  }
  persistTaskRecords(
    context.scheduling,
    recordTaskRecordsForWorktreeMeta(context.runtime, worktreeId, resolved)
  )
}

/** Bind from the last metadata row (a legacy worktree may never have written
 *  one), then settle — both before the row is deleted. `hostId` names the owner
 *  being removed, so a same-id owner on another host keeps its own binding. */
export function recordTaskRecordsOnRemoval(
  context: TaskRecordsMetadataContext,
  worktreeId: string,
  meta?: WorktreeMeta,
  hostId?: ExecutionHostId
): void {
  recordTaskRecordsForWorktree(context, worktreeId, meta)
  settleTaskRecordsBeforeRemoval(
    context.runtime,
    context.scheduling,
    worktreeId,
    Date.now(),
    hostId
  )
}
