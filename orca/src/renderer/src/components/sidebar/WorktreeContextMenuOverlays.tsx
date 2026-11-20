import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { WorktreeParentPickerPopover } from './WorktreeParentPickerPopover'
import { TaskWorkbenchDeliverConfirm } from '@/components/task-workbench/task-workbench-deliver-confirm'
import { translate } from '@/i18n/i18n'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

export function WorktreeContextMenuOverlays({ model }: { model: WorktreeContextMenuModel }) {
  return (
    <>
      <ProjectGroupNameDialog
        open={model.createGroupDialogOpen}
        title={translate(
          'auto.components.sidebar.WorktreeContextMenu.6664418e98',
          'New Project Group'
        )}
        description={translate(
          'auto.components.sidebar.WorktreeContextMenu.c39c37676a',
          'Create a group and move this project into it.'
        )}
        initialName={model.repo ? `${model.repo.displayName} group` : ''}
        confirmLabel="Create"
        onOpenChange={model.handleCreateGroupDialogOpenChange}
        onSubmit={model.handleSubmitNewProjectGroup}
      />
      {model.parentPicker ? (
        <WorktreeParentPickerPopover
          open={model.parentPickerOpen}
          childWorktreeId={model.parentPicker.childWorktreeId}
          anchorElement={model.parentPicker.anchorElement}
          onOpenChange={model.handleParentPickerOpenChange}
        />
      ) : null}
      {/* Why here and not inside the dropdown: the confirmation is the same
          inline popover the Delivery fact row opens (README §7.11.3 rule 1),
          and Radix unmounts the menu content as soon as the item is selected.
          Hosting it next to the dropdown keeps one panel that outlives the menu
          — no second confirm implementation and no modal.

          Why it is not gated on the projection's action again: the panel must
          not vanish under the reader's cursor while the row list updates (e.g.
          the launched tab appearing as the DELIVER marker). Eligibility is not
          assumed, though — the submit re-projects from the latest rows and
          refuses to launch (or reveals the session that won precedence) before
          calling the launcher. */}
      {model.deliverConfirmOpen ? (
        <TaskWorkbenchDeliverConfirm
          heading={model.deliverConfirmHeading}
          {...(model.deliverDefaultTargetBranch !== undefined
            ? { defaultTargetBranch: model.deliverDefaultTargetBranch }
            : {})}
          attention={model.deliverProjection.attention}
          submitting={model.deliverSubmitting}
          onCancel={model.handleDeliverCancel}
          onClose={model.handleDeliverCancel}
          onSubmit={model.handleDeliverSubmit}
          style={model.deliverConfirmStyle}
        />
      ) : null}
    </>
  )
}
