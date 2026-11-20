import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { projectTaskWorkbenchDeliver } from '@/components/task-workbench/task-workbench-deliver-state'
import type { TaskWorkbenchView } from '@/components/task-workbench/task-workbench-view'
import { translate } from '@/i18n/i18n'
import { consumeTaskWorkbenchArchiveIntent } from '@/lib/task-workbench/task-workbench-deliver-archive-intent'

/**
 * Orca-side archive after delivery (README §7.12 D2, A10).
 *
 * Why here and not in the agent's instruction: §7.11.3 rule 8 keeps the agent
 * out of archiving — archiving hides the agent's own report, and archive is a
 * 120s shell hook on the local host that an SSH workspace cannot run. So the
 * agent marks the workspace `completed`, and this hook performs the archive the
 * operator ticked, once, after that fact is observable.
 *
 * Why the intent is in memory: the plan adds no persistence for it. A restart
 * loses the intent and the interface falls back to the workspace row's own
 * Archive action; the toast below states that instead of a silent no-op.
 *
 * Failure handling: the intent is consumed before the write, so a failed
 * archive is reported once and never retried by this effect (A10). The next
 * render sees no intent and does nothing.
 */

const ARCHIVE_FAILED_NOTICE = {
  key: 'auto.components.TaskWorkbenchDelivery.archiveFailed',
  fallback: 'Delivery completed, but archiving the workspace failed. Archive it from the workspace row.'
} as const

export function useTaskWorkbenchDeliverArchive(view: TaskWorkbenchView | null): void {
  // Why keyed on the projection inputs rather than on `view`: the hook is called
  // from a panel that re-renders on every store tick, and the effect must only
  // fire when the state it reads can have changed.
  const state = view === null ? undefined : projectTaskWorkbenchDeliver(view)
  const workspaceId = state?.workspaceId
  const completed = state?.state === 'completed'
  const executionHostId = view?.workspaces.find(
    (workspace) => workspace.worktreeId === workspaceId
  )?.executionHostId

  useEffect(() => {
    if (!completed || workspaceId === undefined) {
      return
    }
    if (!consumeTaskWorkbenchArchiveIntent(workspaceId)) {
      return
    }
    // Why never awaited for a re-render: the row disappearing from the sidebar is
    // the feedback; a failure is a toast, and the PTY is untouched (§7.10).
    void useAppStore
      .getState()
      .updateWorktreeMeta(
        workspaceId,
        { isArchived: true },
        executionHostId === undefined ? undefined : { executionHostId }
      )
      .then((result) => {
        if (result.ok) {
          return
        }
        toast.error(translate(ARCHIVE_FAILED_NOTICE.key, ARCHIVE_FAILED_NOTICE.fallback))
      })
  }, [completed, executionHostId, workspaceId])
}
