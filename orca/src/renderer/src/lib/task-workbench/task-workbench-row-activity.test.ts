import { describe, expect, it } from 'vitest'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import {
  resolveTaskWorkbenchRowActivity,
  type TaskWorkbenchRowActivity,
  type TaskWorkbenchRowAgent,
  type TaskWorkbenchRowInput,
  type TaskWorkbenchRowWorktree
} from './task-workbench-row-activity'

/** The rules themselves live in README §7.2 / D12; this file is the table form
 *  of that section. One row per claim, each pairing the worktrees a row would
 *  bind with the mark the selector must return. */

const GITHUB_ACME_WEB_APP: TaskProviderIdentity = {
  provider: 'github',
  owner: 'acme',
  repo: 'web-app'
}
const GITHUB_ACME_WEB_APP_GHES: TaskProviderIdentity = {
  provider: 'github',
  owner: 'acme',
  repo: 'web-app',
  host: 'ghes.acme.test'
}

function trackerContext(providerIdentity: TaskProviderIdentity | null): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: providerIdentity?.provider ?? 'github',
    projectId: 'project-1',
    hostId: 'local',
    providerIdentity
  }
}

function worktree(
  overrides: Partial<TaskWorkbenchRowWorktree> & { worktreeId: string }
): TaskWorkbenchRowWorktree {
  return {
    repoId: 'repo-1',
    isArchived: false,
    linkedTaskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
    ...overrides
  }
}

/** Worktrees bound to issue #12 of repo-1, one per agent list, in order. */
function bound(...agentsPerWorktree: TaskWorkbenchRowAgent[][]): TaskWorkbenchRowWorktree[] {
  return agentsPerWorktree.map((agents, index) =>
    worktree({ worktreeId: `wt-${index + 1}`, linkedIssue: 12, agents })
  )
}

function issueRow(overrides: Partial<TaskWorkbenchRowInput> = {}): TaskWorkbenchRowInput {
  return {
    rowKey: 'repo-1\0issue:12',
    repoId: 'repo-1',
    itemType: 'issue',
    itemNumber: 12,
    taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
    ...overrides
  }
}

function agent(overrides: Partial<TaskWorkbenchRowAgent> = {}): TaskWorkbenchRowAgent {
  return { dotState: 'working', ...overrides }
}

const WORKING = agent()
const DONE = agent({ dotState: 'done', outcome: 'success' })

/** One row's activity, or `undefined` when the row renders no badge. */
function activityFor(
  worktrees: readonly TaskWorkbenchRowWorktree[],
  row = issueRow()
): TaskWorkbenchRowActivity | undefined {
  return resolveTaskWorkbenchRowActivity({ rows: [row], worktrees }).get(row.rowKey)
}

describe('resolveTaskWorkbenchRowActivity', () => {
  it.each([
    {
      name: 'reads a live working agent as Working, named by the identity selector',
      worktrees: bound([WORKING]),
      expected: {
        kind: 'working',
        dotState: 'working',
        workspaceCount: 1,
        agentCount: 1,
        taskKey: 'tracker:github:acme/web-app'
      }
    },
    {
      name: 'keeps Working when one workspace is working and another is done',
      worktrees: bound([WORKING], [DONE]),
      expected: { kind: 'working', workspaceCount: 2, agentCount: 2 }
    },
    {
      name: 'lets any needs-you agent outrank working and done',
      worktrees: bound([WORKING], [DONE], [agent({ dotState: 'blocked' })]),
      expected: { kind: 'needs-you', dotState: 'blocked' }
    },
    {
      name: 'ranks a failure above the other needs-you marks',
      worktrees: bound([agent({ dotState: 'blocked' })], [agent({ outcome: 'failure' })]),
      expected: { kind: 'needs-you', dotState: 'failed' }
    },
    {
      name: 'renders waiting as its own needs-you glyph',
      worktrees: bound([agent({ dotState: 'waiting' })]),
      expected: { kind: 'needs-you', dotState: 'waiting' }
    },
    {
      name: 'counts a done agent with a success verdict',
      worktrees: bound([DONE]),
      expected: { kind: 'delivered', dotState: 'done' }
    },
    {
      name: 'counts a done agent whose provider never reported an outcome',
      worktrees: bound([agent({ dotState: 'done' })]),
      expected: { kind: 'delivered' }
    },
    {
      name: 'never reads a session boundary as delivery',
      worktrees: bound([agent({ dotState: 'done', sessionBoundary: true })]),
      expected: { kind: 'workspace', dotState: 'idle' }
    },
    {
      name: 'never reads a failed turn as delivery, and surfaces it as needs-you',
      worktrees: bound([agent({ dotState: 'done', outcome: 'failure' })]),
      expected: { kind: 'needs-you', dotState: 'failed' }
    },
    {
      name: 'never reads a cancelled turn as delivery',
      worktrees: bound([agent({ dotState: 'idle', outcome: 'cancellation' })]),
      expected: { kind: 'needs-you', dotState: 'interrupted' }
    },
    {
      name: 'keeps a bound workspace with no agent as the neutral gray Workspace mark',
      worktrees: bound([]),
      expected: { kind: 'workspace', dotState: 'idle', workspaceCount: 1, agentCount: 0 }
    },
    {
      name: 'keeps Workspace for an agent that is idle, since idle claims nothing',
      worktrees: bound([agent({ dotState: 'idle' })]),
      expected: { kind: 'workspace', agentCount: 1 }
    }
  ])('$name', ({ worktrees, expected }) => {
    expect(activityFor(worktrees)).toMatchObject(expected)
  })

  it('never lets an archived workspace contribute or count', () => {
    expect(
      activityFor([
        ...bound([DONE]),
        worktree({
          worktreeId: 'wt-archived',
          linkedIssue: 12,
          isArchived: true,
          agents: [agent({ dotState: 'blocked' })]
        })
      ])
    ).toMatchObject({ kind: 'delivered', workspaceCount: 1, agentCount: 1 })
  })
})

/** Rows that must not get a badge at all: absent from the map, not mapped to a
 *  placeholder, so the list renders nothing rather than an empty mark. */
const NO_BADGE_CASES: { name: string; worktrees: TaskWorkbenchRowWorktree[] }[] = [
  {
    name: 'omits the row entirely when it has no bound workspace',
    worktrees: []
  },
  {
    name: 'omits the row when only an archived workspace is bound',
    worktrees: [
      worktree({ worktreeId: 'wt-1', linkedIssue: 12, isArchived: true, agents: [WORKING] })
    ]
  },
  {
    name: 'omits the row when the bound workspace belongs to another issue',
    worktrees: [worktree({ worktreeId: 'wt-1', linkedIssue: 99, agents: [WORKING] })]
  },
  {
    name: 'omits the row when the worktree was created from the PR with the same number',
    worktrees: [worktree({ worktreeId: 'wt-1', linkedPR: 12, agents: [WORKING] })]
  },
  {
    name: 'omits the row when the same-number worktree belongs to another repo',
    worktrees: [
      worktree({ worktreeId: 'wt-1', repoId: 'repo-2', linkedIssue: 12, agents: [WORKING] })
    ]
  }
]

describe('rows that stay unbadged', () => {
  it.each(NO_BADGE_CASES)('$name', ({ worktrees }) => {
    expect(activityFor(worktrees)).toBeUndefined()
  })
})

describe('row scoping', () => {
  it('does not share one repo worktree across that repo issues', () => {
    const otherIssue = issueRow({ rowKey: 'repo-1\0issue:13', itemNumber: 13 })
    const activity = resolveTaskWorkbenchRowActivity({
      rows: [issueRow(), otherIssue],
      worktrees: bound([WORKING])
    })
    expect(activity.get(issueRow().rowKey)).toMatchObject({ kind: 'working' })
    expect(activity.get(otherIssue.rowKey)).toBeUndefined()
  })

  it('keeps the same item number in two repos apart, host included in each task key', () => {
    const ghes = issueRow({
      rowKey: 'repo-2\0issue:12',
      repoId: 'repo-2',
      taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP_GHES)
    })
    const activity = resolveTaskWorkbenchRowActivity({
      rows: [issueRow(), ghes],
      worktrees: [
        ...bound([WORKING]),
        worktree({
          worktreeId: 'wt-ghes',
          repoId: 'repo-2',
          linkedIssue: 12,
          linkedTaskSourceContext: trackerContext(GITHUB_ACME_WEB_APP_GHES),
          agents: [DONE]
        })
      ]
    })
    expect(activity.get(issueRow().rowKey)).toMatchObject({
      kind: 'working',
      taskKey: 'tracker:github:acme/web-app'
    })
    expect(activity.get(ghes.rowKey)).toMatchObject({
      kind: 'delivered',
      taskKey: 'tracker:github:ghes.acme.test/acme/web-app'
    })
  })
})
