import { useId } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Archive,
  Copy,
  Bell,
  BellOff,
  CircleX,
  Pencil,
  Pin,
  PinOff,
  Send,
  Unlink,
  Workflow,
  FolderInput,
  FolderPlus,
  FolderTree
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorktreeOpenInSubMenu } from './WorktreeOpenInMenu'
import { WorktreeDeveloperMenu } from './WorktreeDeveloperMenu'
import { WorkspaceSleepMenuItems } from './WorkspaceSleepMenuItems'
import { WorktreeContextMenuArchiveDraftItem } from './WorktreeContextMenuDraftAction'
import { WorktreeContextMenuDeleteItem } from './WorktreeContextMenuDeleteItem'
import { isEventTargetInsideCurrentTarget } from './worktree-card-dom-events'
import { translate } from '@/i18n/i18n'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'
import { WorktreeStatusMenuItems } from './WorktreeStatusMenuItems'
import { WorktreeContextMenuOverlays } from './WorktreeContextMenuOverlays'
import {
  CLOSE_ALL_CONTEXT_MENUS_EVENT,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR,
  getWorktreeParentPickerLabel,
  isWorktreeParentPickerDisabled,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldRevealWorktreeDeveloperMenu,
  shouldUseNativeContextMenu
} from './worktree-context-menu-policy'

export default function WorktreeContextMenuView({ model }: { model: WorktreeContextMenuModel }) {
  const {
    archivableWorktrees,
    batchDeleteWorktrees,
    children,
    contentClassName,
    contextDeletePending,
    contextMenuOpenedAtRef,
    contextWorkspaceStatus,
    deleteLabel,
    deletingContext,
    deletingSubtree,
    deliverProjection,
    developerMenuRevealed,
    eligibleParentCount,
    effectiveSelectedWorktrees,
    folderWorkspaceId,
    handleArchive,
    handleArchiveDraft,
    handleAssignWorkspaceStatus,
    handleCloseAutoFocus,
    handleCloseTerminals,
    handleCopyName,
    handleCopyPath,
    handleCreateGroupFromRepo,
    handleDelete,
    handleDeliver,
    handleMoveProjectToGroup,
    handleOpenParent,
    handleOpenParentPicker,
    handleRemoveParentLink,
    handleRemoveProjectFromGroup,
    handleRename,
    handleSleepSubtree,
    handleTogglePin,
    handleToggleRead,
    hasAnyContextLineage,
    hasParentLink,
    isDeleting,
    isMultiContext,
    isTaskDraft,
    lineageDescendantCount,
    menuOpen,
    menuPoint,
    onContextMenuSelect,
    projectGroups,
    removesProject,
    repo,
    scopeRef,
    setContextWorktrees,
    setDeveloperMenuRevealed,
    setMenuOpenState,
    setMenuPoint,
    sleepLabel,
    sleepableWorktrees,
    subtreeSleepableWorktrees,
    suppressOpeningPointerEvent,
    validParentWorktreeId,
    worktree,
    workspaceStatuses
  } = model
  const deleteShortcut = useOptionalShortcutLabel('workspace.delete')
  // Why an id: the reason is sr-only text the item points at with
  // `aria-describedby`. What that establishes is a description *when the item
  // is focused*; it does not make a non-focusable item reachable, which is why
  // the item itself stays focusable (see `deliverItem`).
  const deliverDisabledReasonId = useId()
  const deliverAction = deliverProjection.action
  const deliverDisabledReason =
    deliverAction.kind === 'deliver' && !deliverAction.enabled
      ? translate(deliverAction.disabledReason.key, deliverAction.disabledReason.fallback)
      : null
  // Why the frozen `openTerminal` key and not `deliver`: rule 4 makes an
  // existing DELIVER session open its terminal at this same position, and the
  // task-page entry calls that `打开终端` (`TaskWorkbenchDeliver.openTerminal`).
  // Both entries name the same action, so a reader never sees two verbs for it.
  const deliverLabel =
    deliverAction.kind === 'open-terminal'
      ? translate('auto.components.TaskWorkbenchDeliver.openTerminal', 'Open terminal')
      : translate('auto.components.sidebar.WorktreeContextMenu.deliver', 'Deliver…')
  // Why the same eligibility as Archive: Deliver and Archive are one group with
  // one subject — a linked git worktree of the project. The repository's own
  // checkout is not archivable and is never a delivery target (the launch
  // contract says "never the primary checkout"), and a folder workspace is not
  // a git worktree at all.
  const showsDeliver =
    !isMultiContext &&
    !isTaskDraft &&
    archivableWorktrees.length > 0 &&
    deliverAction.kind !== 'none'
  const deliverItem = (
    <DropdownMenuItem
      data-testid="worktree-context-menu-deliver"
      // Why `aria-disabled` and not Radix's `disabled`: the primitive sets
      // `focusable: false` for a disabled item and filters it out of arrow-key
      // navigation, so the reason would only be reachable in a screen reader's
      // browse mode. An `aria-disabled` item stays focusable and keeps pointer
      // events, so hover reads `title` and focus reads `aria-describedby`;
      // `onSelect` is prevented, so the focus path can never launch.
      aria-disabled={deliverDisabledReason !== null ? true : undefined}
      title={deliverDisabledReason ?? undefined}
      aria-describedby={deliverDisabledReason !== null ? deliverDisabledReasonId : undefined}
      onSelect={
        deliverDisabledReason !== null ? (event) => event.preventDefault() : handleDeliver
      }
    >
      <Send className="size-3.5" />
      {deliverLabel}
    </DropdownMenuItem>
  )
  return (
    <div
      ref={scopeRef}
      className="relative"
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'worktree' }}
      onContextMenuCapture={(event) => {
        if (!isEventTargetInsideCurrentTarget(event.currentTarget, event.target)) {
          return
        }
        if (shouldUseNativeContextMenu(event.target)) {
          return
        }
        if (shouldIgnoreNestedWorktreeContextMenuScope(event.currentTarget, event.target)) {
          return
        }
        event.preventDefault()
        contextMenuOpenedAtRef.current = Date.now()
        window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        setDeveloperMenuRevealed(event.altKey)
        setContextWorktrees(onContextMenuSelect?.(event) ?? effectiveSelectedWorktrees)
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenuPoint({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setMenuOpenState(true)
      }}
      onClickCapture={(event) => {
        suppressOpeningPointerEvent(event)
      }}
    >
      {children}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpenState} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn(lineageDescendantCount > 0 ? 'w-60' : 'w-52', contentClassName)}
          sideOffset={0}
          align="start"
          onPointerUpCapture={suppressOpeningPointerEvent}
          onPointerDownCapture={(event) => {
            if (event.button === 0) {
              contextMenuOpenedAtRef.current = null
            }
          }}
          onMouseUpCapture={suppressOpeningPointerEvent}
          onClickCapture={suppressOpeningPointerEvent}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {translate('auto.components.sidebar.WorktreeContextMenu.workspaceSection', 'Workspace')}
          </DropdownMenuLabel>
          {!isMultiContext && (
            <DropdownMenuItem onSelect={handleRename} disabled={isDeleting}>
              <Pencil className="size-3.5" />
              {translate('auto.components.sidebar.WorktreeContextMenu.439fa94d53', 'Update')}
            </DropdownMenuItem>
          )}
          <WorktreeStatusMenuItems
            contextWorkspaceStatus={contextWorkspaceStatus}
            deletingContext={deletingContext}
            isMultiContext={isMultiContext}
            onAssignWorkspaceStatus={handleAssignWorkspaceStatus}
            workspaceStatuses={workspaceStatuses}
          />
          <DropdownMenuSeparator />
          {!isMultiContext && (
            <>
              <WorktreeOpenInSubMenu
                worktreePath={worktree.path}
                connectionId={repo?.connectionId ?? null}
                disabled={isDeleting}
              />
              <DropdownMenuItem onSelect={handleCopyPath} disabled={isDeleting}>
                <Copy className="size-3.5" />
                {translate('auto.components.sidebar.WorktreeContextMenu.3350101edb', 'Copy Path')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleCopyName} disabled={isDeleting}>
                <Copy className="size-3.5" />
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.copyWorktreeName',
                  'Copy Worktree Name'
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleTogglePin} disabled={isDeleting}>
                {worktree.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {worktree.isPinned
                  ? translate('auto.components.sidebar.WorktreeContextMenu.697d0f6e1b', 'Unpin')
                  : translate('auto.components.sidebar.WorktreeContextMenu.3baa7d6507', 'Pin')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleToggleRead} disabled={isDeleting}>
                {worktree.isUnread ? (
                  <BellOff className="size-3.5" />
                ) : (
                  <Bell className="size-3.5" />
                )}
                {worktree.isUnread
                  ? translate('auto.components.sidebar.WorktreeContextMenu.8dacff1fe0', 'Mark Read')
                  : translate(
                      'auto.components.sidebar.WorktreeContextMenu.f50603c6b2',
                      'Mark Unread'
                    )}
              </DropdownMenuItem>
              {repo ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleCreateGroupFromRepo} disabled={isDeleting}>
                    <FolderPlus className="size-3.5" />
                    {translate(
                      'auto.components.sidebar.WorktreeContextMenu.503ec0f8e6',
                      'New group from project'
                    )}
                  </DropdownMenuItem>
                  {projectGroups.length > 0 ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={isDeleting}>
                        <FolderInput className="size-3.5" />
                        {translate(
                          'auto.components.sidebar.WorktreeContextMenu.76865d827f',
                          'Move to group'
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {projectGroups.map((group) => (
                          <DropdownMenuItem
                            key={group.id}
                            disabled={repo.projectGroupId === group.id}
                            onSelect={() => handleMoveProjectToGroup(group.id)}
                          >
                            <span className="max-w-48 truncate">{group.name}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                  {repo.projectGroupId ? (
                    <DropdownMenuItem onSelect={handleRemoveProjectFromGroup} disabled={isDeleting}>
                      <CircleX className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.d35dfeae58',
                        'Remove from group'
                      )}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleOpenParentPicker}
                disabled={isWorktreeParentPickerDisabled({ isDeleting, eligibleParentCount })}
              >
                <FolderTree className="size-3.5" />
                {getWorktreeParentPickerLabel(validParentWorktreeId)}
              </DropdownMenuItem>
              {(validParentWorktreeId || hasParentLink) && (
                <>
                  {validParentWorktreeId && (
                    <DropdownMenuItem onSelect={handleOpenParent} disabled={isDeleting}>
                      <Workflow className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.8d9cd19d09',
                        'Open Parent Worktree'
                      )}
                    </DropdownMenuItem>
                  )}
                  {hasParentLink && (
                    <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={isDeleting}>
                      <Unlink className="size-3.5" />
                      {translate(
                        'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                        'Remove from Parent'
                      )}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
            </>
          )}
          {isMultiContext && hasAnyContextLineage ? (
            <>
              <DropdownMenuItem onSelect={handleRemoveParentLink} disabled={deletingContext}>
                <Unlink className="size-3.5" />
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.579b1a8e61',
                  'Remove from Parent'
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}

          {shouldRevealWorktreeDeveloperMenu({ developerMenuRevealed, isMultiContext }) ? (
            <>
              <WorktreeDeveloperMenu worktreeId={worktree.id} disabled={isDeleting} />
              <DropdownMenuSeparator />
            </>
          ) : null}
          {showsDeliver ? (
            deliverDisabledReason !== null ? (
              // Why the wrapper: it only hosts the sr-only sentence the item
              // describes itself with. The item itself is focusable and
              // hoverable (`aria-disabled`), so `title` sits on the item where
              // both a mouse and a keyboard user can reach it.
              <div>
                {deliverItem}
                <span id={deliverDisabledReasonId} className="sr-only">
                  {deliverDisabledReason}
                </span>
              </div>
            ) : (
              deliverItem
            )
          ) : null}
          {!isTaskDraft && archivableWorktrees.length > 0 ? (
            <DropdownMenuItem onSelect={handleArchive} disabled={deletingContext}>
              <Archive className="size-3.5" />
              {isMultiContext
                ? translate(
                    'auto.components.sidebar.WorktreeContextMenu.archiveMany',
                    'Archive {{value0}} workspaces',
                    { value0: String(archivableWorktrees.length) }
                  )
                : translate(
                    'auto.components.sidebar.WorktreeContextMenu.archive',
                    'Archive workspace'
                  )}
            </DropdownMenuItem>
          ) : null}
          <WorkspaceSleepMenuItems
            isMultiContext={isMultiContext}
            sleepLabel={sleepLabel}
            sleepDisabled={deletingContext || sleepableWorktrees.length === 0}
            descendantCount={lineageDescendantCount}
            subtreeSleepDisabled={deletingSubtree || subtreeSleepableWorktrees.length === 0}
            onSleep={handleCloseTerminals}
            onSleepSubtree={handleSleepSubtree}
          />
          {isTaskDraft ? (
            <WorktreeContextMenuArchiveDraftItem
              disabled={isDeleting}
              onSelect={handleArchiveDraft}
            />
          ) : null}
          <WorktreeContextMenuDeleteItem
            batchDeleteCount={batchDeleteWorktrees.length}
            contextDeletePending={contextDeletePending}
            deleteLabel={deleteLabel}
            deleteShortcut={deleteShortcut}
            folderWorkspaceId={folderWorkspaceId}
            isMultiContext={isMultiContext}
            isTaskDraft={isTaskDraft}
            lineageDescendantCount={lineageDescendantCount}
            onSelect={handleDelete}
            removesProject={removesProject}
            worktree={worktree}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <WorktreeContextMenuOverlays model={model} />
    </div>
  )
}
