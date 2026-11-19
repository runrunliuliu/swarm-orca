// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard, DashboardSnapshot } from '../../../shared/dashboard-snapshot'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { TaskRunHistoryRecord } from '../../../shared/task-run-history'
import type { Worktree } from '../../../shared/worktree/types'

/**
 * The tab's assembly, not the selectors' rules: a detail page states which item
 * it is, and this hook must hand that item to the selectors so an issue that
 * never ran anything shows nothing instead of the repo's other branches
 * (issue #38).
 *
 * The dashboard snapshot is mocked for the same reason the list hook's test
 * mocks it: it is the store's own agent pipeline, covered where it lives. What
 * this file pins is which worktrees the view was built from.
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
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { useTaskWorkbenchView } from './use-task-workbench-view'

const REPO_ID = 'repo-1'

/** The page's own tracker context: one repo, no item number — exactly what the
 *  detail page hands over, and the shape that used to match the whole repo. */
const GITHUB_WEB_APP: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'local',
  providerIdentity: { provider: 'github', owner: 'acme', repo: 'web-app' }
}

function seed(worktrees: Worktree[]): void {
  useAppStore.setState({ repos: [], worktreesByRepo: { [REPO_ID]: worktrees } })
}

function issueWorktree(id: string, issue: number, extra: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id,
    repoId: REPO_ID,
    linkedIssue: issue,
    // What creating a workspace from the item records: the repo-level tracker
    // context is the provenance the buggy matching read as "this task".
    linkedTaskSourceContext: GITHUB_WEB_APP,
    ...extra
  })
}

function card(worktreeId: string, paneKey: string): DashboardCard {
  return {
    paneKey,
    ptyId: null,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'do the thing',
    repoId: REPO_ID,
    worktreeId,
    tabId: 'tab-1',
    leafId: null,
    repoName: 'acme/web-app',
    worktreeName: worktreeId,
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false
  }
}

/** A deleted-workspace ledger row for this item (issue #31 S2). */
function deletedRecord(worktreeId: string): TaskRunHistoryRecord {
  return {
    repoId: REPO_ID,
    itemType: 'issue',
    number: 9,
    worktreeId,
    path: '/tmp/gone',
    state: 'deleted',
    firstSeenAt: 1,
    updatedAt: 2,
    deletedAt: 2
  }
}

function view(args: { number: number; itemType?: 'issue' | 'pr' }) {
  const itemType = args.itemType ?? 'issue'
  return renderHook(() =>
    useTaskWorkbenchView({
      repoId: REPO_ID,
      number: args.number,
      itemType,
      title: `#${args.number}`,
      taskSourceContext: GITHUB_WEB_APP
    })
  ).result.current
}

beforeEach(() => {
  snapshot = { generatedAt: 0, cards: [] }
  window.api = undefined as never
})

describe('useTaskWorkbenchView — item scope', () => {
  it('shows zero workspaces for an item that never had one', () => {
    // Three branches of the same repo, none of them #9. The repo-level identity
    // matched all three; the item must match none.
    seed([issueWorktree('wt-1', 1), issueWorktree('wt-2', 2), issueWorktree('wt-3', 3)])

    const current = view({ number: 9 })

    expect(current?.workspaces).toEqual([])
    expect(current?.agents).toEqual([])
    expect(current?.identity).toMatchObject({
      kind: 'tracker',
      item: { type: 'issue', number: 9 }
    })
  })

  it('shows only the workspaces of the item it names', () => {
    seed([issueWorktree('wt-1', 1), issueWorktree('wt-2', 2)])

    expect(view({ number: 1 })?.workspaces.map((workspace) => workspace.worktreeId)).toEqual([
      'wt-1'
    ])
  })

  it('does not answer an issue with the PR of the same number', () => {
    seed([
      makeWorktree({
        id: 'wt-pr-7',
        repoId: REPO_ID,
        linkedPR: 7,
        linkedTaskSourceContext: GITHUB_WEB_APP
      })
    ])

    expect(view({ number: 7 })?.workspaces).toEqual([])
    expect(view({ number: 7, itemType: 'pr' })?.workspaces).toHaveLength(1)
  })

  it('keeps an archived workspace of the item visible as history (issue #31)', () => {
    seed([issueWorktree('wt-9', 9, { isArchived: true })])
    snapshot = { generatedAt: 0, cards: [card('wt-9', 'pane-9')] }

    const current = view({ number: 9 })
    expect(current?.workspaces.map((workspace) => workspace.worktreeId)).toEqual(['wt-9'])
    expect(current?.workspaces[0]?.archived).toBe(true)
    // The archived row is history, never Working, however its card reads.
    expect(current?.agents.map((row) => row.archivedWorkspace)).toEqual([true])
    expect(current?.defaultWorkspace).toEqual({ workspaceId: '', source: 'none' })
  })

  it('does not carry another item’s agent rows into this item', () => {
    // The card belongs to #1's workspace; #9 has none, so the view must not show
    // a row for it even though the repo does have a running agent.
    seed([issueWorktree('wt-1', 1)])
    snapshot = { generatedAt: 0, cards: [card('wt-1', 'pane-1')] }

    expect(view({ number: 9 })?.agents).toEqual([])
    expect(view({ number: 9 })?.workspaces).toEqual([])
    expect(view({ number: 1 })?.agents).toHaveLength(1)
  })

  it('never borrows the repo’s first live worktree when the page names an item', () => {
    // No provider identity on the page, so the identity selector has only
    // provenance to go on — and the repo's branch is still not this item.
    seed([issueWorktree('wt-1', 1)])
    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: null
      })
    ).result.current

    expect(current).toBeNull()
  })

  it('states a deleted workspace’s history without a provider identity (issue #38 review)', async () => {
    // The page knows the item and the repo but carries no provider identity, so
    // no worktree of #9 is left to name it: the run ledger is the only proof it
    // ran. The tab must state that, not the never-started notice — and it must
    // not borrow #1's workspace to get there.
    seed([issueWorktree('wt-1', 1)])
    window.api = {
      taskRunHistory: { get: async () => ({ records: [deletedRecord('repo-1::/gone')] }) }
    } as never

    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: null
      })
    )

    await waitFor(() => expect(current.result.current).not.toBeNull())
    expect(current.result.current?.workspaces).toEqual([])
    expect(current.result.current?.agents).toEqual([])
    expect(current.result.current?.history).toMatchObject({
      trace: 'deleted',
      deletedWorkspaces: 1,
      // S2 stores the mapping, not the runs: unknown, never 0.
      agents: null,
      wall: { kind: 'unknown' }
    })
    expect(current.result.current?.spend).toMatchObject({ kind: 'unavailable' })
  })

  it('keeps the never-started notice when the ledger has nothing for the item', async () => {
    seed([issueWorktree('wt-1', 1)])
    window.api = { taskRunHistory: { get: async () => ({ records: [] }) } } as never

    const current = renderHook(() =>
      useTaskWorkbenchView({
        repoId: REPO_ID,
        number: 9,
        itemType: 'issue',
        title: '#9',
        taskSourceContext: null
      })
    )

    await waitFor(() => expect(current.result.current).toBeNull())
  })
})
