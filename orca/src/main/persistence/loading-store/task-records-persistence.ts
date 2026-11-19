import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  isReadableTaskRecords,
  taskRecordForTask as lookupRecord,
  taskRecordTaskId,
  type TaskRecordLookup
} from '../../../shared/task-records'
import { EMPTY_TASK_RECORDS } from '../../../shared/task-records-types'
import {
  mergeTaskRecordBindingSessions,
  setTaskRecordBindingSettlement,
  upsertTaskRecordBinding,
  type TaskRecordsWriteResult
} from '../../../shared/task-records-updates'
import type { TaskRecord, TaskRecordsState } from '../../../shared/task-records-types'
import {
  taskRecordLinksForWorktree,
  type TaskRecordLink
} from '../../../shared/task-records-worktree-links'
import type { TaskRecordsUsageSource } from '../../task-records/task-records-worktree-usage'
import { scheduleSave } from './write-scheduling'
import type { WriteSchedulingOperations } from './write-scheduling'

/**
 * The single write point of the `taskRecords` domain (issue #36). Task metadata
 * is written in exactly one place (the worktree metadata operations), so the
 * binding set is derived there too; a second producer would be a second truth
 * about which task a workspace belongs to.
 *
 * Two rules this module owns:
 * - **fail closed**: a payload this build cannot read is never rewritten. The
 *   load path keeps it verbatim, and every function here returns early.
 * - **no blocked workspace work**: nothing here throws into a metadata write or
 *   a removal. A refusal is reported and the stored state is left alone, because
 *   a task ledger must not be able to break the workspace list.
 */

/** Only what these functions need, so a test can supply a plain state object
 *  instead of a whole Store. `StoreRuntimeState` satisfies it structurally. */
export type TaskRecordsRuntime = {
  state: {
    taskRecords?: TaskRecordsState
    /** Only the metadata hook reads this; kept optional so a test can omit it. */
    worktreeMeta?: Record<string, WorktreeMeta>
  }
  taskRecordsUsageSource?: TaskRecordsUsageSource | null
}

export function recordTaskRecordsForWorktreeMeta(
  runtime: TaskRecordsRuntime,
  worktreeId: string,
  meta: Pick<WorktreeMeta, 'isArchived'> & Parameters<typeof taskRecordLinksForWorktree>[1]
): boolean {
  const stored = runtime.state.taskRecords
  if (!isReadableTaskRecords(stored)) {
    return false
  }
  const links = taskRecordLinksForWorktree(worktreeId, meta)
  let current = stored ?? EMPTY_TASK_RECORDS
  let changed = false
  for (const link of links) {
    const result = upsertTaskRecordBinding(current, {
      taskId: taskIdForLink(link),
      hostId: link.hostId,
      repoId: link.repoId,
      worktreeId,
      path: link.path,
      isArchived: meta.isArchived,
      origin: link.origin,
      now: Date.now()
    })
    if (!result.ok) {
      reportRefusal('record binding', worktreeId, result)
      continue
    }
    current = result.state
    changed = changed || result.changed
  }
  if (changed) {
    runtime.state.taskRecords = current
  }
  return changed
}

/**
 * Settlement and session capture, run *before* the worktree row is dropped
 * (development plan §M2b C/E). The figures are read from the usage stores'
 * in-process snapshot; a failure here is reported and never thrown, so a broken
 * usage store cannot turn "delete this workspace" into an error the user cannot
 * get past.
 */
export function settleTaskRecordsBeforeRemoval(
  runtime: TaskRecordsRuntime,
  scheduling: WriteSchedulingOperations | null,
  worktreeId: string,
  now = Date.now()
): boolean {
  const stored = runtime.state.taskRecords
  if (!isReadableTaskRecords(stored) || stored === undefined) {
    return false
  }
  const affected = Object.values(stored.byId).filter((record) =>
    record.bindings.some((binding) => binding.worktreeId === worktreeId)
  )
  if (affected.length === 0) {
    return false
  }
  const source = runtime.taskRecordsUsageSource
  if (!source) {
    return false
  }
  const hostId =
    affected[0].bindings.find((binding) => binding.worktreeId === worktreeId)?.hostId ??
    affected[0].hostId
  let current = stored
  try {
    const snapshot = source.snapshotForRemoval({ worktreeId, hostId, now })
    for (const record of affected) {
      // Sessions first, then the settlement: a refused session merge (the
      // per-binding cap) must not cost the figure that can never be read again.
      const withSessions = mergeTaskRecordBindingSessions(current, {
        taskId: record.taskId,
        worktreeId,
        sessions: snapshot.sessions,
        now
      })
      if (withSessions.ok) {
        current = withSessions.state
        if (withSessions.dropped !== undefined) {
          console.error(
            `[task-records] ${withSessions.dropped} sessions over the per-binding cap for ${worktreeId}`
          )
        }
      } else {
        reportRefusal('record sessions', worktreeId, withSessions)
      }
      const withSettlement = setTaskRecordBindingSettlement(current, {
        taskId: record.taskId,
        worktreeId,
        settlement: snapshot.settlement
      })
      if (withSettlement.ok) {
        current = withSettlement.state
      } else {
        reportRefusal('record settlement', worktreeId, withSettlement)
      }
    }
  } catch (error) {
    // Never block the removal: the record simply keeps its previous state.
    console.error('[task-records] usage settlement failed', worktreeId, error)
    return false
  }
  if (current === stored) {
    return false
  }
  runtime.state.taskRecords = current
  if (scheduling) {
    scheduleSave(scheduling, ['taskRecords'])
  }
  return true
}

export function persistTaskRecords(scheduling: WriteSchedulingOperations, changed: boolean): void {
  if (changed) {
    scheduleSave(scheduling, ['taskRecords'])
  }
}

/** The one record of a task page; the lookup rules (provider-qualified or
 *  single-claim suffix match) live in the shared module, so the renderer's view
 *  of "which task is this" cannot differ from the writer's. */
export function taskRecordForTask(
  state: TaskRecordsState | undefined,
  query: TaskRecordLookup
): TaskRecord | null {
  return isReadableTaskRecords(state) ? lookupRecord(state, query) : null
}

function taskIdForLink(link: TaskRecordLink): string {
  if (link.origin.kind === 'workspace') {
    return `task:workspace:${link.origin.primaryWorktreeId}`
  }
  // The link already carries the repo registration this worktree belongs to, so
  // the id stays stable after the checkout is gone.
  return taskRecordTaskId({
    provider: link.origin.provider,
    repoId: link.repoId,
    itemType: link.origin.itemType,
    number: link.origin.number
  })
}

function reportRefusal(
  action: string,
  worktreeId: string,
  result: Extract<TaskRecordsWriteResult, { ok: false }>
): void {
  console.error(`[task-records] ${action} refused for ${worktreeId}: ${result.reason}`)
}
