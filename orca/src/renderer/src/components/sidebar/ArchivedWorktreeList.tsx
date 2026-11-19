import React, { useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'

/**
 * Archived workspaces of one repo, inside the visibility dialog.
 *
 * Why here rather than a sidebar fold: the sidebar list is one virtualized,
 * sorted, draggable pipeline, and an archived row has no place in that order.
 * This dialog is already the "what is hidden and how do I bring it back" surface,
 * so Restore belongs next to the other hidden-worktree recovery entries.
 *
 * Restore is one metadata write: the checkout, branch and trace were never
 * touched by Archive.
 */
export default function ArchivedWorktreeList({ repo }: { repo: Repo }): React.JSX.Element | null {
  const worktrees = useAppStore((state) => state.worktreesByRepo?.[repo.id])
  const updateWorktreeMeta = useAppStore((state) => state.updateWorktreeMeta)
  const [busyId, setBusyId] = useState<string | null>(null)

  const archived = (worktrees ?? []).filter((worktree) => worktree.isArchived)
  if (archived.length === 0) {
    return null
  }

  const restore = async (worktreeId: string, executionHostId: ExecutionHostId | undefined): Promise<void> => {
    setBusyId(worktreeId)
    try {
      await updateWorktreeMeta(
        worktreeId,
        { isArchived: false },
        { executionHostId: executionHostId ?? LOCAL_EXECUTION_HOST_ID }
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="grid min-w-0 gap-2">
      <div>
        <h3 className="text-sm font-medium">
          {translate(
            'auto.components.sidebar.ArchivedWorktreeList.heading',
            'Archived workspaces ({{value0}})',
            { value0: String(archived.length) }
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.sidebar.ArchivedWorktreeList.description',
            'Hidden from the sidebar; the checkout and its recorded trace are still on disk.'
          )}
        </p>
      </div>
      <ul className="grid min-w-0 gap-1">
        {archived.map((worktree) => {
          const name = worktree.displayName || worktree.branch || worktree.id
          return (
            <li
              key={worktree.id}
              className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {worktree.path}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busyId === worktree.id}
                aria-label={translate(
                  'auto.components.sidebar.ArchivedWorktreeList.restoreAria',
                  'Restore {{value0}}',
                  { value0: name }
                )}
                onClick={() => void restore(worktree.id, worktree.hostId)}
              >
                <ArchiveRestore className="size-3.5" />
                {translate('auto.components.sidebar.ArchivedWorktreeList.restore', 'Restore')}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
