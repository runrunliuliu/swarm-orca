// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSnapshot } from '../../../shared/dashboard-snapshot'
import type { TaskSourceContext } from '../../../shared/task-source-context'
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

    expect(view({ number: 9 })?.workspaces.map((workspace) => workspace.worktreeId)).toEqual([
      'wt-9'
    ])
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
})
