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
  worktreeId: string
): void {
  const meta = context.runtime.state.worktreeMeta?.[worktreeId]
  if (!meta) {
    return
  }
  persistTaskRecords(
    context.scheduling,
    recordTaskRecordsForWorktreeMeta(context.runtime, worktreeId, meta)
  )
}

/** Bind from the last metadata row (a legacy worktree may never have written
 *  one), then settle — both before the row is deleted. */
export function recordTaskRecordsOnRemoval(
  context: TaskRecordsMetadataContext,
  worktreeId: string
): void {
  recordTaskRecordsForWorktree(context, worktreeId)
  settleTaskRecordsBeforeRemoval(context.runtime, context.scheduling, worktreeId)
}
