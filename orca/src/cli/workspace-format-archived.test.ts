import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeRecord } from '../shared/runtime-types'
import { formatWorktreeList } from './workspace-format'

/**
 * Issue #31 / non-destructive cleanup: an archived worktree is hidden from the
 * workspace list but still exists. The text listing must say so, otherwise
 * `worktree archive` looks like a silent no-op and `unarchive` needs a guessed id.
 *
 * Kept in its own file because `format.test.ts` is at its `max-lines` budget.
 */
function archivedWorktree(): RuntimeWorktreeRecord {
  return {
    id: 'repo::/tmp/repo/archived',
    repoId: 'repo',
    path: '/tmp/repo/archived',
    head: 'abc123',
    branch: 'feature/archived',
    isBare: false,
    isMainWorktree: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: true,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    git: {
      path: '/tmp/repo/archived',
      head: 'abc123',
      branch: 'feature/archived',
      isBare: false,
      isMainWorktree: false
    },
    displayName: 'Archived task',
    comment: ''
  } as RuntimeWorktreeRecord
}

describe('formatWorktreeList — archive state', () => {
  it('marks an archived worktree so it stays discoverable for unarchive', () => {
    const output = formatWorktreeList({
      worktrees: [archivedWorktree()],
      totalCount: 1,
      truncated: false
    })

    expect(output).toContain('repo::/tmp/repo/archived')
    expect(output).toContain('archived: true')
  })

  it('does not mark an active worktree', () => {
    const output = formatWorktreeList({
      worktrees: [{ ...archivedWorktree(), isArchived: false }],
      totalCount: 1,
      truncated: false
    })

    expect(output).not.toContain('archived: true')
  })
})
