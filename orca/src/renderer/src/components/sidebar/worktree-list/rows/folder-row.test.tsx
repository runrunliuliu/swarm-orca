// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { WorkspaceLinkedItem } from '../../../../../../shared/worktree/types'
import {
  getFolderDraftMarker,
  getTaskDraftLinkLabel,
  resolveFolderDraftState
} from './folder-draft-marker'

function makeWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'project-group-1',
    name: 'add-login-retry',
    folderPath: '/tmp/task-drafts/draft-key',
    linkedTask: null,
    taskDraft: true,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function linkedTask(overrides: Partial<WorkspaceLinkedItem> = {}): WorkspaceLinkedItem {
  return {
    provider: 'github',
    type: 'issue',
    number: 412,
    title: 'Add login retry',
    url: 'https://github.com/acme/web-app/issues/412',
    ...overrides
  }
}

describe('resolveFolderDraftState', () => {
  const base = { taskDraft: true, isArchived: false, hasLinkedTask: false, taskRemoved: false }

  it('returns null for a workspace that is not a draft', () => {
    expect(resolveFolderDraftState({ ...base, taskDraft: false })).toBeNull()
  })

  it('reports draft, linked, task-removed and archived', () => {
    expect(resolveFolderDraftState(base)).toBe('draft')
    expect(resolveFolderDraftState({ ...base, hasLinkedTask: true })).toBe('linked')
    expect(resolveFolderDraftState({ ...base, hasLinkedTask: true, taskRemoved: true })).toBe(
      'task-removed'
    )
    expect(resolveFolderDraftState({ ...base, isArchived: true })).toBe('archived')
  })

  it('keeps archive above a stale removal marker', () => {
    expect(
      resolveFolderDraftState({ ...base, isArchived: true, hasLinkedTask: true, taskRemoved: true })
    ).toBe('archived')
  })
})

describe('getTaskDraftLinkLabel', () => {
  it('numbers GitHub and GitLab tasks', () => {
    expect(getTaskDraftLinkLabel({ provider: 'github', number: 412 })).toBe('#412')
    expect(getTaskDraftLinkLabel({ provider: 'gitlab', number: 7 })).toBe('#7')
  })

  it('uses the tracker identifier for Linear and Jira', () => {
    expect(getTaskDraftLinkLabel({ provider: 'linear', identifier: 'ENG-123' })).toBe('ENG-123')
    expect(getTaskDraftLinkLabel({ provider: 'jira', identifier: 'OPS-9' })).toBe('OPS-9')
  })

  it('returns an empty label when the tracker identifier is missing', () => {
    expect(getTaskDraftLinkLabel({ provider: 'linear' })).toBe('')
    expect(getTaskDraftLinkLabel({ provider: 'github' })).toBe('')
  })
})

describe('getFolderDraftMarker', () => {
  it('returns null for a non-draft workspace', () => {
    expect(getFolderDraftMarker(makeWorkspace({ taskDraft: undefined }), false)).toBeNull()
  })

  it('marks an unlinked draft without a link label', () => {
    expect(getFolderDraftMarker(makeWorkspace(), false)).toEqual({
      badge: 'draft',
      linkLabel: null,
      state: 'draft'
    })
  })

  it('labels a linked GitHub draft with its number', () => {
    expect(getFolderDraftMarker(makeWorkspace({ linkedTask: linkedTask() }), false)).toEqual({
      badge: 'draft',
      linkLabel: '#412',
      state: 'linked'
    })
  })

  it('labels a linked Linear draft with its identifier', () => {
    const workspace = makeWorkspace({
      linkedTask: linkedTask({ provider: 'linear', number: 9, linearIdentifier: 'ENG-9' })
    })
    expect(getFolderDraftMarker(workspace, false)?.linkLabel).toBe('ENG-9')
  })

  it('labels a linked Jira draft with its identifier', () => {
    const workspace = makeWorkspace({
      linkedTask: linkedTask({ provider: 'jira', number: 3, jiraIdentifier: 'OPS-3' })
    })
    expect(getFolderDraftMarker(workspace, false)?.linkLabel).toBe('OPS-3')
  })

  it('reports the removal marker and archive state', () => {
    expect(getFolderDraftMarker(makeWorkspace({ linkedTask: linkedTask() }), true)?.state).toBe(
      'task-removed'
    )
    expect(getFolderDraftMarker(makeWorkspace({ isArchived: true }), false)?.state).toBe('archived')
  })
})
