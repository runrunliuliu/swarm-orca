import type { PersistedState } from '../../../shared/persisted-state-types'

export const TASK_DRAFT_INACTIVE_ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Archive drafts that linked a task and then sat idle past the grace period. Pure over
 * persisted state: one load-time pass, no file I/O, no provider, no timer.
 */
export function archiveInactiveTaskDrafts(
  state: PersistedState,
  now = Date.now(),
  limit = 100
): number {
  let archived = 0
  for (const workspace of state.folderWorkspaces) {
    if (archived >= limit) {
      break
    }
    if (workspace.taskDraft !== true || workspace.isArchived === true) {
      continue
    }
    // Why linked only: an unlinked draft is unfinished work, not a forgotten row.
    if (!workspace.linkedTask) {
      continue
    }
    // Why 0 is skipped: unknown activity cannot prove 30 days elapsed.
    const idleCutoff = now - TASK_DRAFT_INACTIVE_ARCHIVE_MS
    if (!workspace.lastActivityAt || workspace.lastActivityAt >= idleCutoff) {
      continue
    }
    workspace.isArchived = true
    archived++
  }
  return archived
}
