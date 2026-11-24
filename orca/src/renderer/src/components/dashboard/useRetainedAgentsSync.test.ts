import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState
} from '../../../../shared/agent-status-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { RetainedAgentEntry } from '../../store/slices/agent-status'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { buildRetainedAgentsSyncSnapshot } from './useRetainedAgents'

const ACTIVE_PANE_KEY = makePaneKey('tab-active', '22222222-2222-4222-8222-222222222222')
const ARCHIVED_PANE_KEY = makePaneKey('tab-archived', '33333333-3333-4333-8333-333333333333')
const DELETED_PANE_KEY = makePaneKey('tab-deleted', '66666666-6666-4666-8666-666666666666')
const FOLDER_PANE_KEY = makePaneKey('tab-folder', '44444444-4444-4444-8444-444444444444')
const ARCHIVED_FOLDER_PANE_KEY = makePaneKey(
  'tab-folder-archived',
  '55555555-5555-4555-8555-555555555555'
)

function makeFolderWorkspace(overrides?: Partial<FolderWorkspace>): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/repo/folder',
    linkedTask: null,
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

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  }
}

function makeWorktree(overrides?: Partial<Worktree>): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makeTab(overrides?: Partial<TerminalTab>): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeEntry(args: {
  paneKey: string
  state: AgentStatusState
  updatedAt: number
  stateStartedAt?: number
  prompt?: string
  toolName?: string
}): AgentStatusEntry {
  return {
    state: args.state,
    prompt: args.prompt ?? 'Fix it',
    updatedAt: args.updatedAt,
    stateStartedAt: args.stateStartedAt ?? args.updatedAt,
    paneKey: args.paneKey,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    toolName: args.toolName
  }
}

describe('buildRetainedAgentsSyncSnapshot', () => {
  it('builds live rows for non-archived worktrees and stale-decays active states', () => {
    const repo = makeRepo()
    const activeWorktree = makeWorktree({ id: 'wt-active' })
    const archivedWorktree = makeWorktree({ id: 'wt-archived', isArchived: true })
    const activeTab = makeTab({ id: 'tab-active', worktreeId: 'wt-active' })
    const archivedTab = makeTab({ id: 'tab-archived', worktreeId: 'wt-archived' })

    const snapshot = buildRetainedAgentsSyncSnapshot({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [activeWorktree, archivedWorktree] },
      folderWorkspaces: [],
      tabsByWorktree: {
        [activeWorktree.id]: [activeTab],
        [archivedWorktree.id]: [archivedTab]
      },
      agentStatusByPaneKey: {
        [ACTIVE_PANE_KEY]: makeEntry({
          paneKey: ACTIVE_PANE_KEY,
          state: 'working',
          updatedAt: 10_000,
          stateStartedAt: 10_000
        }),
        [ARCHIVED_PANE_KEY]: makeEntry({
          paneKey: ARCHIVED_PANE_KEY,
          state: 'done',
          updatedAt: 20_000,
          stateStartedAt: 20_000
        })
      },
      now: 10_000 + AGENT_STATUS_STALE_AFTER_MS + 1
    })

    // The archived id stays in the prune allowlist (issue #31): archiving must
    // not delete the retained rows of a task the user finished.
    expect([...snapshot.existingWorktreeIds]).toEqual(['wt-active', 'wt-archived'])
    expect(snapshot.currentAgents.get(ACTIVE_PANE_KEY)?.row.state).toBe('idle')
    expect(snapshot.currentAgents.get(ARCHIVED_PANE_KEY)).toBeUndefined()
  })

  it('builds live rows for non-archived folder workspaces and skips archived ones', () => {
    const folderWorkspace = makeFolderWorkspace()
    const archivedFolderWorkspace = makeFolderWorkspace({ id: 'folder-2', isArchived: true })
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    const archivedWorkspaceKey = folderWorkspaceKey(archivedFolderWorkspace.id)
    const tab = makeTab({ id: 'tab-folder', worktreeId: workspaceKey })
    const archivedTab = makeTab({ id: 'tab-folder-archived', worktreeId: archivedWorkspaceKey })

    const snapshot = buildRetainedAgentsSyncSnapshot({
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [folderWorkspace, archivedFolderWorkspace],
      tabsByWorktree: { [workspaceKey]: [tab], [archivedWorkspaceKey]: [archivedTab] },
      agentStatusByPaneKey: {
        [FOLDER_PANE_KEY]: makeEntry({
          paneKey: FOLDER_PANE_KEY,
          state: 'done',
          updatedAt: 10_000
        }),
        [ARCHIVED_FOLDER_PANE_KEY]: makeEntry({
          paneKey: ARCHIVED_FOLDER_PANE_KEY,
          state: 'done',
          updatedAt: 10_000
        })
      },
      now: 10_000
    })

    // Both ids are prune-allowlisted; only the live one contributes rows.
    expect([...snapshot.existingWorktreeIds]).toEqual([workspaceKey, archivedWorkspaceKey])
    expect(snapshot.currentAgents.get(FOLDER_PANE_KEY)?.worktreeId).toBe(workspaceKey)
    expect(snapshot.currentAgents.get(ARCHIVED_FOLDER_PANE_KEY)).toBeUndefined()
  })
})

/**
 * Issue #31's "第 0 步止血" is only true end to end if the allowlist this sync
 * builds is actually the one `pruneRetainedAgents` receives: the two halves were
 * tested apart (the allowlist contains the archived id; prune keeps ids that are
 * in the set), so a regression that dropped archived ids from the allowlist — or
 * stopped pruning a removed one — could still pass both halves separately.
 *
 * Why the deleted worktree is absent rather than flagged: deletion removes the
 * worktree from every list the sync reads, so "not in `existingWorktreeIds`" is
 * exactly what deletion looks like here. Archiving only flips `isArchived` and
 * keeps the id in those lists.
 */
describe('pruneRetainedAgents against the sync allowlist (issue #31)', () => {
  it('keeps a row whose worktree was archived and prunes one whose worktree is gone', () => {
    const repo = makeRepo()
    const archivedWorktree = makeWorktree({ id: 'wt-archived', isArchived: true })
    const snapshot = buildRetainedAgentsSyncSnapshot({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [archivedWorktree] },
      folderWorkspaces: [],
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      now: 20_000
    })

    // The pair of facts the assertions below depend on: the archived id is in
    // the allowlist, the deleted one is not.
    expect(snapshot.existingWorktreeIds.has('wt-archived')).toBe(true)
    expect(snapshot.existingWorktreeIds.has('wt-deleted')).toBe(false)

    const retainedFor = (
      paneKey: string,
      worktreeId: string,
      tabId: string
    ): RetainedAgentEntry => ({
      entry: makeEntry({ paneKey, state: 'done', updatedAt: 20_000 }),
      worktreeId,
      tab: makeTab({ id: tabId, worktreeId }),
      agentType: 'claude',
      startedAt: 20_000
    })

    const store = createTestStore()
    store.getState().retainAgents([
      retainedFor(ARCHIVED_PANE_KEY, 'wt-archived', 'tab-archived'),
      retainedFor(DELETED_PANE_KEY, 'wt-deleted', 'tab-deleted')
    ])

    store.getState().pruneRetainedAgents(snapshot.existingWorktreeIds)

    const retained = store.getState().retainedAgentsByPaneKey
    // Archived is not deleted: the finished task keeps the row the user can
    // still read once the worktree is put away.
    expect(retained[ARCHIVED_PANE_KEY]).toBeDefined()
    expect(retained[ARCHIVED_PANE_KEY]?.worktreeId).toBe('wt-archived')
    expect(retained[DELETED_PANE_KEY]).toBeUndefined()
  })
})
