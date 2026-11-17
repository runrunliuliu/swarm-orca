import React from 'react'
import { Trash2 } from 'lucide-react'
import type { Worktree } from '../../../../shared/worktree/types'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** The existing delete item and its primary-checkout parity row, moved out of the view. */
export function WorktreeContextMenuDeleteItem({
  batchDeleteCount,
  contextDeletePending,
  deleteLabel,
  deleteShortcut,
  folderWorkspaceId,
  isMultiContext,
  isTaskDraft,
  lineageDescendantCount,
  onSelect,
  removesProject,
  worktree
}: {
  batchDeleteCount: number
  contextDeletePending: boolean
  deleteLabel: string
  deleteShortcut: string | null
  folderWorkspaceId: string | null
  isMultiContext: boolean
  isTaskDraft: boolean
  lineageDescendantCount: number
  onSelect: () => void
  removesProject: boolean
  worktree: Worktree
}): React.JSX.Element {
  return (
    <>
      {/* Why: primary checkout rows can't be git-worktree-removed, so keep a
         disabled Delete Worktree for parity with non-primary cards and pair
         it with the enabled Remove Project action below. */}
      {!isMultiContext && removesProject ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <DropdownMenuItem variant="destructive" disabled>
                <Trash2 className="size-3.5" />
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.deleteWorktree',
                  'Delete Worktree'
                )}
              </DropdownMenuItem>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="max-w-[200px]">
            {translate(
              'auto.components.sidebar.WorktreeContextMenu.primaryDeleteDisabled',
              "Primary worktree — can't be deleted. Remove the project instead."
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* Why: primary checkout rows remove the project from Orca instead of
         invoking git worktree deletion. Radix forwards unknown props to the
         DOM element, so `title` works directly without a wrapper span —
         this preserves Radix's flat roving-tabindex keyboard navigation. */}
      <DropdownMenuItem
        variant="destructive"
        onSelect={onSelect}
        disabled={
          contextDeletePending ||
          (!isMultiContext && worktree.isMainWorktree && !removesProject) ||
          (isMultiContext && batchDeleteCount === 0)
        }
        title={
          !isMultiContext && worktree.isMainWorktree && !removesProject
            ? translate(
                'auto.components.sidebar.WorktreeContextMenu.e091caab15',
                'The project could not be found'
              )
            : undefined
        }
      >
        <Trash2 className="size-3.5" />
        {contextDeletePending
          ? translate('auto.components.sidebar.WorktreeContextMenu.b42391d8bf', 'Deleting…')
          : isMultiContext
            ? deleteLabel
            : folderWorkspaceId
              ? isTaskDraft
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.deleteDraft',
                    'Delete draft'
                  )
                : translate(
                    'auto.components.sidebar.WorktreeContextMenu.250de158fd',
                    'Remove Workspace'
                  )
              : removesProject
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.f5ac91531d',
                    'Remove Project from Orca'
                  )
                : lineageDescendantCount > 0
                  ? translate(
                      'auto.components.sidebar.WorktreeContextMenu.deleteWithDescendants',
                      'Delete with Descendants…'
                    )
                  : translate(
                      'auto.components.sidebar.WorktreeContextMenu.f4475537d8',
                      'Delete'
                    )}
        {!isMultiContext && !removesProject && deleteShortcut ? (
          <DropdownMenuShortcut>{deleteShortcut}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
    </>
  )
}
