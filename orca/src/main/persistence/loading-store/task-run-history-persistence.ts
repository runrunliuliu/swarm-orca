import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import {
  markTaskRunHistoryDeleted,
  normalizeTaskRunHistory,
  upsertTaskRunHistoryRecord,
  worktreePathFromId,
  type TaskRunHistoryItemType,
  type TaskRunHistoryState
} from '../../../shared/task-run-history'
import { scheduleSave } from './write-scheduling'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'

/**
 * Keep the worktree → task ledger in step with the metadata row that owns the
 * link. This is the single write point for issue #31 S2: creation, archive and
 * (together with `removeWorktreeMeta`) deletion all pass through here, so the
 * renderer never has to trust an out-of-band cache.
 *
 * Only GitHub issue/PR links are recorded today; that is the workbench's current
 * scope. A worktree linked to both gets one record per task, because the two
 * task pages are separate tasks.
 */
export function recordTaskRunLinks(
  runtime: Pick<StoreRuntimeState, 'state'>,
  worktreeId: string,
  meta: Pick<WorktreeMeta, 'linkedIssue' | 'linkedPR' | 'isArchived' | 'lastActivityAt'>,
  options: { now?: number; state?: 'active' | 'archived' | 'deleted' } = {}
): boolean {
  if (!splitWorktreeIdForFilesystem(worktreeId)) {
    return false
  }
  const state = options.state ?? (meta.isArchived ? 'archived' : 'active')
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const path = worktreePathFromId(worktreeId)
  const now = options.now ?? Date.now()
  const links: { itemType: TaskRunHistoryItemType; number: number }[] = []
  if (typeof meta.linkedIssue === 'number' && meta.linkedIssue > 0) {
    links.push({ itemType: 'issue', number: meta.linkedIssue })
  }
  if (typeof meta.linkedPR === 'number' && meta.linkedPR > 0) {
    links.push({ itemType: 'pr', number: meta.linkedPR })
  }
  if (links.length === 0) {
    return false
  }

  let current: TaskRunHistoryState | undefined = runtime.state.taskRunHistory
  let changed = false
  for (const link of links) {
    const result = upsertTaskRunHistoryRecord(current, {
      repoId,
      itemType: link.itemType,
      number: link.number,
      worktreeId,
      path,
      state,
      now,
      ...(meta.lastActivityAt === undefined ? {} : { lastActivityAt: meta.lastActivityAt })
    })
    current = result.state
    changed = changed || result.changed
  }
  if (changed) {
    runtime.state.taskRunHistory = current
  }
  return changed
}

/** A removal marks the worktree's records deleted; it never drops them. Legacy
 *  worktrees without a ledger row seed one from their last meta first. */
export function recordTaskRunWorktreeDeleted(
  runtime: Pick<StoreRuntimeState, 'state'>,
  worktreeId: string,
  storedMeta: WorktreeMeta | undefined,
  now = Date.now()
): boolean {
  let changed = false
  if (storedMeta) {
    changed = recordTaskRunLinks(runtime, worktreeId, storedMeta, { now, state: 'deleted' })
  }
  const current = normalizeTaskRunHistory(runtime.state.taskRunHistory)
  const marked = markTaskRunHistoryDeleted(current, worktreeId, now)
  if (marked.changed) {
    runtime.state.taskRunHistory = marked.state
    changed = true
  }
  return changed
}

export function persistTaskRunHistory(
  scheduling: WriteSchedulingOperations,
  changed: boolean
): void {
  if (changed) {
    scheduleSave(scheduling, ['taskRunHistory'])
  }
}
