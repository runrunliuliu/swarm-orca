import { describe, expect, it } from 'vitest'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { resolveTaskIdentity } from './task-workbench-identity'
import type { IdentityWorktree } from './task-workbench-selector-types'

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
  isArchived = false
): IdentityWorktree {
  return {
    worktreeId,
    isArchived,
    linkedTaskSourceContext: linkedProviderIdentity ? trackerContext(linkedProviderIdentity) : null
  }
}

describe('resolveTaskIdentity — task source context', () => {
  it('uses the tracker identity the task itself carries and keeps worktree order', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        worktrees: [
          worktree('wt-b', GITHUB_ACME_WEB_APP),
          worktree('wt-archived', GITHUB_ACME_WEB_APP, true),
          worktree('wt-a', GITHUB_ACME_WEB_APP)
        ]
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' }
      },
      taskKey: 'tracker:github:acme/web-app',
      source: 'task-source-context',
      matchedWorktreeIds: ['wt-b', 'wt-a']
    })
  })

  it('keeps a GHES host in the task key and does not match the github.com identity', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP_GHES),
        worktrees: [
          worktree('wt-dotcom', GITHUB_ACME_WEB_APP),
          worktree('wt-ghes', GITHUB_ACME_WEB_APP_GHES)
        ]
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app', host: 'ghes.acme.test' }
      },
      taskKey: 'tracker:github:ghes.acme.test/acme/web-app',
      source: 'task-source-context',
      matchedWorktreeIds: ['wt-ghes']
    })
  })

  it('resolves a tracker even when no worktree is linked yet', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        worktrees: []
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' }
      },
      taskKey: 'tracker:github:acme/web-app',
      source: 'task-source-context',
      matchedWorktreeIds: []
    })
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
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' }
      },
      taskKey: 'tracker:github:acme/web-app',
      source: 'worktree',
      matchedWorktreeIds: ['wt-github']
    })
  })

  it('falls back to a live worktree linked context when the task source identity is null', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(null),
        worktrees: [worktree('wt-local', null), worktree('wt-github', GITHUB_ACME_WEB_APP)]
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' }
      },
      taskKey: 'tracker:github:acme/web-app',
      source: 'worktree',
      matchedWorktreeIds: ['wt-github']
    })
  })

  it('does not treat a different provider as the same task', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: trackerContext(GITHUB_ACME_WEB_APP),
        worktrees: [worktree('wt-linear', LINEAR_FINANCE)]
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'github', owner: 'acme', repo: 'web-app' }
      },
      taskKey: 'tracker:github:acme/web-app',
      source: 'task-source-context',
      matchedWorktreeIds: []
    })
  })
})

describe('resolveTaskIdentity — workspace fallback', () => {
  it('uses the first live worktree as the task when nothing is linked', () => {
    expect(
      resolveTaskIdentity({
        taskSourceContext: null,
        worktrees: [worktree('wt-first', null), worktree('wt-second', null)]
      })
    ).toEqual({
      identity: { kind: 'workspace', primaryWorktreeId: 'wt-first' },
      taskKey: 'workspace:wt-first',
      source: 'workspace-fallback',
      matchedWorktreeIds: ['wt-first']
    })
  })

  it('skips an archived first worktree on both the tracker and fallback paths', () => {
    expect(
      resolveTaskIdentity({
        worktrees: [
          worktree('wt-old', GITHUB_ACME_WEB_APP, true),
          worktree('wt-linear', LINEAR_FINANCE)
        ]
      })
    ).toEqual({
      identity: {
        kind: 'tracker',
        provider: { provider: 'linear', workspaceId: 'ws-orca', teamId: 'team-fin' }
      },
      taskKey: 'tracker:linear:ws-orca/team-fin',
      source: 'worktree',
      matchedWorktreeIds: ['wt-linear']
    })
    expect(
      resolveTaskIdentity({
        worktrees: [worktree('wt-old', null, true), worktree('wt-new', null)]
      })
    ).toEqual({
      identity: { kind: 'workspace', primaryWorktreeId: 'wt-new' },
      taskKey: 'workspace:wt-new',
      source: 'workspace-fallback',
      matchedWorktreeIds: ['wt-new']
    })
  })
})

describe('resolveTaskIdentity — no identity', () => {
  it('returns null without a task source context or a worktree', () => {
    expect(resolveTaskIdentity({ worktrees: [] })).toBeNull()
    expect(resolveTaskIdentity({ taskSourceContext: null, worktrees: [] })).toBeNull()
  })

  it('returns null when only archived worktrees exist', () => {
    expect(
      resolveTaskIdentity({ worktrees: [worktree('wt-old', GITHUB_ACME_WEB_APP, true)] })
    ).toBeNull()
  })
})
