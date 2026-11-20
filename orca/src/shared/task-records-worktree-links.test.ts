import { describe, expect, it } from 'vitest'
import { taskRecordLinksForWorktree } from './task-records-worktree-links'

const ID = 'repo-1::/repo/feature'

describe('task records from worktree metadata', () => {
  it('reads the GitHub issue and PR fields as two separate tasks', () => {
    const links = taskRecordLinksForWorktree(ID, {
      linkedIssue: 31,
      linkedPR: 9,
      linkedWorkItem: null,
      linkedTaskSourceContext: null
    })

    expect(links.map((link) => [link.origin.kind, link.repoId, link.path])).toEqual([
      ['external', 'repo-1', '/repo/feature'],
      ['external', 'repo-1', '/repo/feature']
    ])
    expect(
      links.map((link) => (link.origin.kind === 'external' ? link.origin.itemType : null))
    ).toEqual(['issue', 'pr'])
  })

  it('prefers the provider-agnostic link and does not duplicate it', () => {
    const links = taskRecordLinksForWorktree(ID, {
      linkedIssue: 31,
      linkedPR: null,
      linkedWorkItem: {
        provider: 'linear',
        type: 'issue',
        number: 31,
        title: 'Ship the workbench',
        url: 'https://linear.app/acme/issue/ENG-31',
        linearIdentifier: 'ENG-31'
      },
      linkedTaskSourceContext: null
    })

    expect(links).toHaveLength(2)
    expect(links[0].origin).toMatchObject({
      kind: 'external',
      provider: 'linear',
      itemType: 'issue',
      number: 31,
      titleSnapshot: 'Ship the workbench'
    })
  })

  it('keeps the provider identity only for the provider that carried it', () => {
    const links = taskRecordLinksForWorktree(ID, {
      linkedIssue: 31,
      linkedPR: null,
      linkedWorkItem: null,
      linkedTaskSourceContext: {
        kind: 'task-source',
        provider: 'github',
        projectId: 'p1',
        hostId: 'local',
        providerIdentity: { provider: 'github', owner: 'acme', repo: 'web-app' }
      }
    })

    expect(links[0].origin).toMatchObject({
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'web-app' }
    })
  })

  it('makes a workspace-origin task from an unlinked worktree', () => {
    const links = taskRecordLinksForWorktree(ID, {
      linkedIssue: null,
      linkedPR: null,
      linkedWorkItem: null,
      linkedTaskSourceContext: null
    })

    expect(links).toEqual([
      {
        repoId: 'repo-1',
        hostId: 'local',
        path: '/repo/feature',
        origin: { kind: 'workspace', primaryWorktreeId: ID }
      }
    ])
  })

  it('ignores a non-positive or unknown link instead of inventing a task', () => {
    const links = taskRecordLinksForWorktree('repo-1::/repo/feature', {
      linkedIssue: 0,
      linkedPR: null,
      // A provider outside the accepted union: the row is stored as plain JSON,
      // so this shape is reachable and must fall back to the workspace origin.
      linkedWorkItem: {
        provider: 'bitbucket',
        type: 'pr',
        number: 4,
        title: 't',
        url: 'u'
      },
      linkedTaskSourceContext: null
    })

    expect(links[0].origin).toEqual({
      kind: 'workspace',
      primaryWorktreeId: 'repo-1::/repo/feature'
    })
  })

  it('returns nothing for a worktree id that is not a locator', () => {
    expect(
      taskRecordLinksForWorktree('not-a-locator', {
        linkedIssue: 31,
        linkedPR: null,
        linkedWorkItem: null,
        linkedTaskSourceContext: null
      })
    ).toEqual([])
  })
})
