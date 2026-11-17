import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'

export type TaskDraftRowState = 'draft' | 'linked' | 'archived'

export function resolveFolderDraftState(args: {
  taskDraft: boolean
  isArchived: boolean
  hasLinkedTask: boolean
}): TaskDraftRowState | null {
  if (!args.taskDraft) {
    return null
  }
  if (args.isArchived) {
    return 'archived'
  }
  return args.hasLinkedTask ? 'linked' : 'draft'
}

export function getTaskDraftLinkLabel(args: {
  provider: 'github' | 'gitlab' | 'linear' | 'jira'
  number?: number | null
  identifier?: string | null
}): string {
  if (args.provider === 'linear' || args.provider === 'jira') {
    return args.identifier?.trim() ?? ''
  }
  return typeof args.number === 'number' ? `#${args.number}` : ''
}

export type FolderDraftMarker = {
  badge: 'draft'
  linkLabel: string | null
  state: TaskDraftRowState
}

export function getFolderDraftMarker(workspace: FolderWorkspace): FolderDraftMarker | null {
  const state = resolveFolderDraftState({
    taskDraft: workspace.taskDraft === true,
    isArchived: workspace.isArchived,
    hasLinkedTask: workspace.linkedTask !== null
  })
  if (!state) {
    return null
  }
  const linkedTask = workspace.linkedTask
  const linkLabel =
    linkedTask === null
      ? null
      : getTaskDraftLinkLabel({
          provider: linkedTask.provider,
          number: linkedTask.number,
          identifier:
            linkedTask.provider === 'linear'
              ? linkedTask.linearIdentifier
              : linkedTask.provider === 'jira'
                ? linkedTask.jiraIdentifier
                : null
        }) || null
  return { badge: 'draft', linkLabel, state }
}
