import { describe, expect, it } from 'vitest'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'
import {
  resolveTaskIdentity,
  selectTaskItemWorktrees,
  worktreeLinksTaskItem
} from './task-workbench-identity'
import type { IdentityWorktree, TaskWorkbenchItem } from './task-workbench-selector-types'

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

const LINEAR_FINANCE: TaskProviderIdentity = {
  provider: 'linear',
  workspaceId: 'ws-orca',
  teamId: 'team-fin'
}

const ISSUE_9: TaskWorkbenchItem = { type: 'issue', number: 9 }
const ISSUE_1: TaskWorkbenchItem = { type: 'issue', number: 1 }
const ISSUE_7: TaskWorkbenchItem = { type: 'issue', number: 7 }
const PR_7: TaskWorkbenchItem = { type: 'pr', number: 7 }

/** A stored task source context: `provider` follows the identity so the fixture
 *  stays a shape the normalizers could actually have produced. */
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
  worktreeId: string,
  linkedProviderIdentity: TaskProviderIdentity | null,
  options: {
    archived?: boolean
    linkedIssue?: number
    linkedPR?: number
    linkedItem?: WorkspaceLinkedItem
  } = {}
): IdentityWorktree {
  return {
    worktreeId,
    isArchived: options.archived ?? false,
    ...(options.linkedIssue === undefined ? {} : { linkedIssue: options.linkedIssue }),
    ...(options.linkedPR === undefined ? {} : { linkedPR: options.linkedPR }),
    ...(options.linkedItem === undefined ? {} : { linkedWorkItem: options.linkedItem }),
    linkedTaskSourceContext: linkedProviderIdentity ? trackerContext(linkedProviderIdentity) : null
  }
}

/** A GitHub link record, the shape creation writes next to the number column. */
function githubItem(type: 'issue' | 'pr', number: number): WorkspaceLinkedItem {
  return {
    provider: 'github',
    type,
    number,
    title: `#${number}`,
    url: `https://github.com/acme/web-app/${type === 'issue' ? 'issues' : 'pull'}/${number}`
  }
}

function ids(worktrees: readonly IdentityWorktree[]): string[] {
  return worktrees.map((worktree) => worktree.worktreeId)
}

describe('resolveTaskIdentity — task source context', () => {
  it('names the item, not the repo, when the page knows which item it is', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        item: { type: 'issue', number: 412 },
        worktrees: []
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' },
        item: { type: 'issue', number: 412 }
      },
      taskKey: 'tracker:github:acme/web-app:issue:412',
      source: 'task-source-context'
    })
  })

  it('keeps the item out of the key when the caller did not name one', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        worktrees: []
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' },
        item: null
      },
      taskKey: 'tracker:github:acme/web-app',
      source: 'task-source-context'
    })
  })

  it('keeps a GHES host in the item-scoped task key', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP_GHES),
        item: ISSUE_9,
        worktrees: []
      })
    ).toMatchObject({
      identity: { provider: { host: 'ghes.acme.test' }, item: ISSUE_9 },
      taskKey: 'tracker:github:ghes.acme.test/acme/web-app:issue:9',
      source: 'task-source-context'
    })
  })

  it('ignores an item number that is not a tracker number', () => {
    // Jira / Linear rows carry 0 next to their own identifier; matching it would
    // make every such workspace the same item.
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        item: { type: 'issue', number: 0 },
        worktrees: []
      })
    ).toMatchObject({ identity: { kind: 'tracker', item: null } })
  })
})

describe('worktree selection — the item decides the collection (issue #38)', () => {
  const threeIssues = [
    worktree('wt-1', GITHUB_ACME_WEB_APP, { linkedIssue: 1, linkedItem: githubItem('issue', 1) }),
    worktree('wt-2', GITHUB_ACME_WEB_APP, { linkedIssue: 2, linkedItem: githubItem('issue', 2) }),
    worktree('wt-3', GITHUB_ACME_WEB_APP, { linkedIssue: 3, linkedItem: githubItem('issue', 3) })
  ]

  it('selects nothing for an item that never had a workspace', () => {
    // The bug: one repo-level identity matched all three, so opening #9 showed
    // three workspaces full of other issues' agents.
    expect(selectTaskItemWorktrees(threeIssues, ISSUE_9, GITHUB_ACME_WEB_APP)).toEqual([])
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        item: ISSUE_9,
        worktrees: threeIssues
      })
    ).toMatchObject({ taskKey: 'tracker:github:acme/web-app:issue:9' })
  })

  it('selects only the item that owns the workspace', () => {
    expect(ids(selectTaskItemWorktrees(threeIssues, ISSUE_1, GITHUB_ACME_WEB_APP))).toEqual([
      'wt-1'
    ])
  })

  it('selects every workspace of the item, archived included (issue #31)', () => {
    expect(
      ids(
        selectTaskItemWorktrees(
          [
            worktree('wt-live', GITHUB_ACME_WEB_APP, { linkedIssue: 9 }),
            worktree('wt-archived', GITHUB_ACME_WEB_APP, { linkedIssue: 9, archived: true }),
            worktree('wt-other', GITHUB_ACME_WEB_APP, { linkedIssue: 8 })
          ],
          ISSUE_9,
          GITHUB_ACME_WEB_APP
        )
      )
    ).toEqual(['wt-live', 'wt-archived'])
  })

  it('keeps an issue and a PR with the same number apart', () => {
    const issueSeven = worktree('wt-issue-7', GITHUB_ACME_WEB_APP, {
      linkedIssue: 7,
      linkedItem: githubItem('issue', 7)
    })
    const prSeven = worktree('wt-pr-7', GITHUB_ACME_WEB_APP, {
      linkedPR: 7,
      linkedItem: githubItem('pr', 7)
    })
    expect(ids(selectTaskItemWorktrees([issueSeven, prSeven], ISSUE_7, null))).toEqual([
      'wt-issue-7'
    ])
    expect(ids(selectTaskItemWorktrees([issueSeven, prSeven], PR_7, null))).toEqual(['wt-pr-7'])
  })

  it('matches the provider-neutral link record when there is no number column', () => {
    // A GitLab MR has no `linkedPR`, so `linkedWorkItem` is the only evidence;
    // `mr` answers a PR page and never an issue page.
    const gitlabMr = worktree('wt-mr', null, {
      linkedItem: { provider: 'gitlab', type: 'mr', number: 7, title: '!7', url: 'https://gl/7' }
    })
    expect(ids(selectTaskItemWorktrees([gitlabMr], PR_7, null))).toEqual(['wt-mr'])
    expect(selectTaskItemWorktrees([gitlabMr], ISSUE_7, null)).toEqual([])
  })

  it('does not let a GHES branch answer a github.com item', () => {
    const dotcom = worktree('wt-dotcom', GITHUB_ACME_WEB_APP, { linkedIssue: 9 })
    const ghes = worktree('wt-ghes', GITHUB_ACME_WEB_APP_GHES, { linkedIssue: 9 })
    expect(ids(selectTaskItemWorktrees([dotcom, ghes], ISSUE_9, GITHUB_ACME_WEB_APP))).toEqual([
      'wt-dotcom'
    ])
    expect(ids(selectTaskItemWorktrees([dotcom, ghes], ISSUE_9, GITHUB_ACME_WEB_APP_GHES))).toEqual(
      ['wt-ghes']
    )
  })

  it('accepts a legacy workspace that only carries the number column', () => {
    // Workspaces created before `linkedWorkItem` existed (or discovered on disk)
    // have the number and no provenance; the link is the evidence.
    expect(
      ids(
        selectTaskItemWorktrees(
          [worktree('wt-legacy', null, { linkedIssue: 9 })],
          ISSUE_9,
          GITHUB_ACME_WEB_APP
        )
      )
    ).toEqual(['wt-legacy'])
    expect(
      worktreeLinksTaskItem(
        worktree('wt-legacy', null, { linkedIssue: 8 }),
        ISSUE_9,
        GITHUB_ACME_WEB_APP
      )
    ).toBe(false)
  })

  it('does not let one provider link answer another provider item', () => {
    const linearWorktree = worktree('wt-linear', LINEAR_FINANCE, { linkedIssue: 9 })
    expect(selectTaskItemWorktrees([linearWorktree], ISSUE_9, GITHUB_ACME_WEB_APP)).toEqual([])
  })
})

describe('resolveTaskIdentity — worktree provenance', () => {
  it('falls back to a live worktree linked context when the task source is absent', () => {
    expect(
      resolveTaskIdentity({
        worktrees: [worktree('wt-local', null), worktree('wt-github', GITHUB_ACME_WEB_APP)]
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' },
        item: null
      },
      taskKey: 'tracker:github:acme/web-app',
      source: 'worktree'
    })
  })

  it('reads provenance only from the worktree that links the item', () => {
    // Two issues of one repo: the caller asked for #9, so #1's branch may not
    // name it, and an item-less worktree may not either.
    expect(
      resolveTaskIdentity({
        item: ISSUE_9,
        worktrees: [
          worktree('wt-1', GITHUB_ACME_WEB_APP, { linkedIssue: 1 }),
          worktree('wt-9', GITHUB_ACME_WEB_APP, { linkedIssue: 9 })
        ]
      })
    ).toMatchObject({
      identity: { kind: 'tracker', item: ISSUE_9 },
      taskKey: 'tracker:github:acme/web-app:issue:9',
      source: 'worktree'
    })
  })

  it('does not treat a different provider as the same task', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        worktrees: [worktree('wt-linear', LINEAR_FINANCE)]
      })
    ).toMatchObject({ identity: { kind: 'tracker', provider: GITHUB_ACME_WEB_APP } })
  })
})

describe('resolveTaskIdentity — workspace fallback', () => {
  it('uses the first live worktree as the task when nothing is linked and no item is named', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: null,
        worktrees: [worktree('wt-first', null), worktree('wt-second', null)]
      })
    ).toEqual({
      identity: { kind: 'workspace', primaryWorktreeId: 'wt-first' },
      taskKey: 'workspace:wt-first',
      source: 'workspace-fallback'
    })
  })

  it('never falls back to another branch of the repo when an item is named', () => {
    // Acceptance criterion of issue #38: the repo's live worktree is not this
    // item's workspace, so #9 stays empty instead of borrowing #1's branch.
    expect(
      resolveTaskIdentity({
        taskSourceContext: null,
        item: ISSUE_9,
        worktrees: [
          worktree('wt-1', null, { linkedIssue: 1 }),
          worktree('wt-2', null, { linkedIssue: 2 })
        ]
      })
    ).toBeNull()
  })

  it('falls back to the item’s own legacy worktree, not the first live one', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: null,
        item: ISSUE_9,
        worktrees: [
          worktree('wt-other', null, { linkedIssue: 1 }),
          worktree('wt-nine', null, { linkedIssue: 9 })
        ]
      })
    ).toEqual({
      identity: { kind: 'workspace', primaryWorktreeId: 'wt-nine' },
      taskKey: 'workspace:wt-nine',
      source: 'workspace-fallback'
    })
  })

  it('skips an archived first worktree on both the tracker and fallback paths', () => {
    expect(
      resolveTaskIdentity({
        worktrees: [
          worktree('wt-old', GITHUB_ACME_WEB_APP, { archived: true }),
          worktree('wt-linear', LINEAR_FINANCE)
        ]
      })
    ).toMatchObject({
      identity: { kind: 'tracker', provider: LINEAR_FINANCE },
      taskKey: 'tracker:linear:ws-orca/team-fin',
      source: 'worktree'
    })
    expect(
      resolveTaskIdentity({
        worktrees: [worktree('wt-old', null, { archived: true }), worktree('wt-new', null)]
      })
    ).toEqual({
      identity: { kind: 'workspace', primaryWorktreeId: 'wt-new' },
      taskKey: 'workspace:wt-new',
      source: 'workspace-fallback'
    })
  })
})

describe('resolveTaskIdentity — no identity', () => {
  it('returns null without a task source context or a worktree', () => {
    expect(resolveTaskIdentity({ worktrees: [] })).toBeNull()
    expect(resolveTaskIdentity({ taskSourceContext: null, worktrees: [] })).toBeNull()
    expect(
      resolveTaskIdentity({ taskSourceContext: null, item: ISSUE_9, worktrees: [] })
    ).toBeNull()
  })

  it('names a task whose only worktree was archived (issue #31)', () => {
    // A closed task keeps its history: the archived worktree is the last proof
    // of which task this is, so the tab must not fall back to "no identity".
    expect(
      resolveTaskIdentity({
        worktrees: [worktree('wt-old', GITHUB_ACME_WEB_APP, { archived: true })]
      })
    ).toMatchObject({
      identity: { kind: 'tracker', provider: GITHUB_ACME_WEB_APP },
      source: 'archived-worktree'
    })
    expect(
      resolveTaskIdentity({ worktrees: [worktree('wt-old', null, { archived: true })] })
    ).toEqual({
      identity: { kind: 'workspace', primaryWorktreeId: 'wt-old' },
      taskKey: 'workspace:wt-old',
      source: 'archived-worktree'
    })
  })

  it('still names a closed item from its archived worktree', () => {
    expect(
      resolveTaskIdentity({
        item: ISSUE_9,
        worktrees: [worktree('wt-old', GITHUB_ACME_WEB_APP, { archived: true, linkedIssue: 9 })]
      })
    ).toMatchObject({
      identity: { kind: 'tracker', item: ISSUE_9 },
      source: 'archived-worktree'
    })
    expect(
      resolveTaskIdentity({
        item: ISSUE_9,
        worktrees: [worktree('wt-old', null, { archived: true, linkedIssue: 9 })]
      })
    ).toEqual({
      identity: { kind: 'workspace', primaryWorktreeId: 'wt-old' },
      taskKey: 'workspace:wt-old',
      source: 'archived-worktree'
    })
  })
})
