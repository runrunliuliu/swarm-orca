import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildDashboardBucketCounts } from '../dashboard/build-dashboard-bucket-counts'
import type { DashboardSnapshotState } from '../dashboard/build-dashboard-snapshot'
import { collectActiveDashboardWorkspaces } from '../dashboard/dashboard-snapshot-workspaces'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()
const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

function paneKey(tabId: string, leaf: '1' | '2' = '1'): string {
  return makePaneKey(tabId, leaf === '1' ? LEAF_ID_1 : LEAF_ID_2)
}

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? 'pty-1',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    title: overrides.title ?? 'bash',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0
  }
}

function makeEntry(overrides: {
  paneKey: string
  worktreeId?: string
  tabId?: string
  state?: 'blocked' | 'working' | 'done' | 'waiting'
  stateStartedAt?: number
  updatedAt?: number
}) {
  return {
    state: overrides.state ?? 'working',
    prompt: '',
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    stateStartedAt: overrides.stateStartedAt ?? overrides.updatedAt ?? NOW - 30_000,
    agentType: 'codex' as const,
    paneKey: overrides.paneKey,
    worktreeId: overrides.worktreeId,
    tabId: overrides.tabId,
    terminalTitle: undefined,
    stateHistory: [],
    interrupted: undefined,
    mainAgent: undefined
  }
}

describe('task draft exclusion from attention and Recent surfaces', () => {
  it('drops an attention-worthy draft before dashboard Needs You counting', () => {
    const draft: FolderWorkspace = {
      id: 'draft-folder',
      projectGroupId: 'group-1',
      name: 'Draft issue',
      folderPath: '/tmp/task-draft',
      linkedTask: null,
      taskDraft: true,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW
    }
    const projectGroup: ProjectGroup = {
      id: 'group-1',
      name: 'Project',
      parentPath: '/tmp',
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: NOW,
      updatedAt: NOW
    }
    const worktreeId = folderWorkspaceKey(draft.id)
    const tabId = 'draft-tab'
    const key = paneKey(tabId)
    const state = {
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [draft],
      projectGroups: [projectGroup],
      tabsByWorktree: { [worktreeId]: [makeTab({ id: tabId, worktreeId })] },
      agentStatusByPaneKey: {
        [key]: makeEntry({
          paneKey: key,
          worktreeId,
          tabId,
          state: 'blocked',
          stateStartedAt: NOW,
          updatedAt: NOW
        })
      },
      retainedAgentsByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: { [tabId]: ['pty-1'] },
      runtimePaneTitlesByTabId: {},
      acknowledgedAgentsByPaneKey: {},
      settings: null
    } satisfies DashboardSnapshotState

    expect(collectActiveDashboardWorkspaces(state, false)).toEqual([])
    expect(buildDashboardBucketCounts(state, NOW)).toEqual({
      attention: 0,
      working: 0,
      done: 0,
      idle: 0
    })
  })

  it('keeps folder workspaces out of the Smart and Recent worktree input by construction', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/sidebar/visible-worktrees.ts'),
      'utf8'
    )

    expect(source).toContain('const allWorktrees = getAllWorktreesFromState')
    expect(source).not.toContain('folderWorkspaceToWorktree')
    expect(source).not.toContain('state.folderWorkspaces')
  })
})
