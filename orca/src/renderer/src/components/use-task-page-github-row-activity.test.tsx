// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { DashboardCard, DashboardSnapshot } from '../../../shared/dashboard-snapshot'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

/**
 * The list-page glue the pure selector cannot see: a dashboard card becomes an
 * agent claim (dot state + F8 verdict + session boundary), the worktree's link
 * names the row, and the page is projected once.
 *
 * The dashboard snapshot is mocked rather than built: `useLiveDashboardSnapshot`
 * is the store's own agent pipeline, covered where it lives. Rebuilding an agent
 * fleet here would test the dashboard, not this wiring.
 */

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

let snapshot: DashboardSnapshot = { generatedAt: 0, cards: [] }
vi.mock('@/components/dashboard/useLiveDashboardSnapshot', () => ({
  useLiveDashboardSnapshot: () => snapshot
}))

import { useAppStore } from '@/store'
import { makeTab, makeWorktree } from '@/store/slices/store-test-helpers'
import type { TaskWorkbenchRowActivity } from '@/lib/task-workbench/task-workbench-row-activity'
import { useTaskPageGitHubRowActivity } from './use-task-page-github-row-activity'
import type { TaskPageGitHubRowActivitySource } from './use-task-page-github-row-activity'

const REPO_ID = 'repo-1'
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const ITEM_12 = `${REPO_ID}\0issue:12`
const ITEM_13 = `${REPO_ID}\0issue:13`

const REPO: Repo = {
  id: REPO_ID,
  displayName: 'acme/web-app',
  badgeColor: '#123456',
  path: '/tmp/acme-web-app',
  addedAt: 1
}

function model(
  items: { id: string; number: number }[],
  worktrees: Worktree[]
): TaskPageGitHubRowActivitySource {
  return {
    repoMap: new Map([[REPO_ID, REPO]]),
    allWorktrees: worktrees,
    filteredWorkItems: items.map((item) => ({
      id: item.id,
      type: 'issue',
      number: item.number,
      title: `Issue ${item.number}`,
      state: 'open',
      url: `https://github.com/acme/web-app/issues/${item.number}`,
      labels: [],
      updatedAt: new Date(0).toISOString(),
      author: 'octocat',
      repoId: REPO_ID
    }))
  }
}

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: PANE_KEY,
    ptyId: null,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'Add login auth',
    repoId: REPO_ID,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: null,
    repoName: 'acme/web-app',
    worktreeName: 'issue-12',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false,
    ...overrides
  }
}

function setAgentStatus(entry: Partial<AgentStatusEntry>): void {
  useAppStore.setState({
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        state: 'working',
        prompt: 'Add login auth',
        updatedAt: 1,
        stateStartedAt: 1,
        agentType: 'claude',
        paneKey: PANE_KEY,
        stateHistory: [],
        ...entry
      }
    }
  })
}

function activityByKey(
  worktrees: Worktree[],
  items = [{ id: 'issue:12', number: 12 }]
): ReadonlyMap<string, TaskWorkbenchRowActivity> {
  return renderHook(() => useTaskPageGitHubRowActivity(model(items, worktrees))).result.current
    .rowActivityByKey
}

/** The store facts a projected card cannot carry, mapped to the badge claim. */
const STATUS_CASES: {
  name: string
  status: Partial<AgentStatusEntry>
  card: Partial<DashboardCard>
  expected: Partial<TaskWorkbenchRowActivity>
}[] = [
  {
    name: 'carries a failure verdict into the badge',
    status: { mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 } },
    card: { dotState: 'done', bucket: 'done' },
    expected: { kind: 'needs-you', dotState: 'failed' }
  },
  {
    name: 'keeps a session boundary out of Delivered',
    status: { sessionBoundary: true },
    card: { dotState: 'done', bucket: 'done' },
    expected: { kind: 'workspace', dotState: 'idle' }
  },
  {
    name: 'keeps a legacy interrupted row out of Delivered',
    status: { state: 'done', interrupted: true },
    card: { dotState: 'done', bucket: 'done' },
    expected: { kind: 'needs-you', dotState: 'interrupted' }
  }
]

/** A completed agent whose live entry is gone: the dashboard still projects its
 *  card, and only `retainedAgentsByPaneKey` holds the verdict. */
function retainAgentStatus(entry: Partial<AgentStatusEntry>): void {
  useAppStore.setState({
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {
      [PANE_KEY]: {
        entry: {
          state: 'done',
          prompt: 'Add login auth',
          updatedAt: 1,
          stateStartedAt: 1,
          agentType: 'claude',
          paneKey: PANE_KEY,
          stateHistory: [],
          ...entry
        },
        worktreeId: 'wt-1',
        tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
        agentType: 'claude',
        startedAt: 1
      }
    }
  })
}

beforeEach(() => {
  snapshot = { generatedAt: 0, cards: [] }
  useAppStore.setState({ retainedAgentsByPaneKey: {} })
  setAgentStatus({})
})

describe('useTaskPageGitHubRowActivity', () => {
  it('maps a working agent card to the row its worktree is linked to', () => {
    snapshot = { generatedAt: 0, cards: [card()] }
    expect(
      activityByKey([makeWorktree({ id: 'wt-1', repoId: REPO_ID, linkedIssue: 12 })]).get(ITEM_12)
    ).toMatchObject({ kind: 'working', workspaceCount: 1, agentCount: 1 })
  })

  it.each(STATUS_CASES)('$name', ({ status, card: cardOverrides, expected }) => {
    setAgentStatus(status)
    snapshot = { generatedAt: 0, cards: [card(cardOverrides)] }
    expect(
      activityByKey([makeWorktree({ id: 'wt-1', repoId: REPO_ID, linkedIssue: 12 })]).get(ITEM_12)
    ).toMatchObject(expected)
  })

  it('reads a retained entry, so a completed failure is not read as Delivered', () => {
    retainAgentStatus({ mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 } })
    snapshot = { generatedAt: 0, cards: [card({ dotState: 'done', bucket: 'idle' })] }
    expect(
      activityByKey([makeWorktree({ id: 'wt-1', repoId: REPO_ID, linkedIssue: 12 })]).get(ITEM_12)
    ).toMatchObject({ kind: 'needs-you', dotState: 'failed' })
  })

  it('ignores a card belonging to an archived worktree', () => {
    snapshot = { generatedAt: 0, cards: [card()] }
    expect(
      activityByKey([makeWorktree({ id: 'wt-1', repoId: REPO_ID, linkedIssue: 12, isArchived: true })])
        .size
    ).toBe(0)
  })

  it('badges only the row a workspace was created for', () => {
    snapshot = { generatedAt: 0, cards: [card()] }
    const activity = activityByKey(
      [makeWorktree({ id: 'wt-1', repoId: REPO_ID, linkedIssue: 12 })],
      [
        { id: 'issue:12', number: 12 },
        { id: 'issue:13', number: 13 }
      ]
    )
    expect(activity.has(ITEM_12)).toBe(true)
    expect(activity.has(ITEM_13)).toBe(false)
  })
})
