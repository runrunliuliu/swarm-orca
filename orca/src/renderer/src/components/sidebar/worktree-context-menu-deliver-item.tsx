import React, { useId } from 'react'
import { Send } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { TaskWorkbenchDeliverProjection } from '@/components/task-workbench/task-workbench-deliver-state'

/**
 * The Deliver item and the reason wrapper around it, moved out of the view.
 *
 * Why self-contained: the item's label, its disabled reason and whether it
 * belongs in the menu are all readings of the same projection, so keeping them
 * next to the JSX leaves the view with one call instead of five derivations.
 */
export function WorktreeContextMenuDeliverItem({
  archivableWorktreeCount,
  isMultiContext,
  isTaskDraft,
  onSelect,
  projection
}: {
  archivableWorktreeCount: number
  isMultiContext: boolean
  isTaskDraft: boolean
  onSelect: () => void
  projection: TaskWorkbenchDeliverProjection
}): React.JSX.Element | null {
  // Why an id: the reason is sr-only text the item points at with
  // `aria-describedby`. What that establishes is a description *when the item
  // is focused*; it does not make a non-focusable item reachable, which is why
  // the item itself stays focusable (see the item below).
  const disabledReasonId = useId()
  const action = projection.action
  const disabledReason =
    action.kind === 'deliver' && !action.enabled
      ? translate(action.disabledReason.key, action.disabledReason.fallback)
      : null
  // Why the frozen `openTerminal` key and not `deliver`: rule 4 makes an
  // existing DELIVER session open its terminal at this same position, and the
  // task-page entry calls that `打开终端` (`TaskWorkbenchDeliver.openTerminal`).
  // Both entries name the same action, so a reader never sees two verbs for it.
  const label =
    action.kind === 'open-terminal'
      ? translate('auto.components.TaskWorkbenchDeliver.openTerminal', 'Open terminal')
      : action.kind === 'open-session'
        ? translate('auto.components.TaskWorkbenchDeliver.openSession', 'Open session')
        : translate('auto.components.sidebar.WorktreeContextMenu.deliver', 'Deliver…')
  // Why the same eligibility as Archive: Deliver and Archive are one group with
  // one subject — a linked git worktree of the project. The repository's own
  // checkout is not archivable and is never a delivery target (the launch
  // contract says "never the primary checkout"), and a folder workspace is not
  // a git worktree at all.
  if (
    isMultiContext ||
    isTaskDraft ||
    archivableWorktreeCount === 0 ||
    action.kind === 'none'
  ) {
    return null
  }
  const item = (
    <DropdownMenuItem
      data-testid="worktree-context-menu-deliver"
      // Why `aria-disabled` and not Radix's `disabled`: the primitive sets
      // `focusable: false` for a disabled item and filters it out of arrow-key
      // navigation, so the reason would only be reachable in a screen reader's
      // browse mode. An `aria-disabled` item stays focusable and keeps pointer
      // events, so hover reads `title` and focus reads `aria-describedby`;
      // `onSelect` is prevented, so the focus path can never launch.
      aria-disabled={disabledReason !== null ? true : undefined}
      title={disabledReason ?? undefined}
      aria-describedby={disabledReason !== null ? disabledReasonId : undefined}
      onSelect={disabledReason !== null ? (event) => event.preventDefault() : onSelect}
    >
      <Send className="size-3.5" />
      {label}
    </DropdownMenuItem>
  )
  if (disabledReason === null) {
    return item
  }
  // Why the wrapper: it only hosts the sr-only sentence the item describes
  // itself with. The item itself is focusable and hoverable (`aria-disabled`),
  // so `title` sits on the item where both a mouse and a keyboard user can
  // reach it.
  return (
    <div>
      {item}
      <span id={disabledReasonId} className="sr-only">
        {disabledReason}
      </span>
    </div>
  )
}
