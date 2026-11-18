import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'

const existingMeta: WorktreeMeta = {
  displayName: 'Feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  suppressedGitHubPR: 42,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

describe('worktree metadata write normalization', () => {
  it('clears GitHub PR suppression on every positive linked PR update', () => {
    const updated = mergeWorktreeMetaForWrite(existingMeta, {
      linkedPR: 42,
      suppressedGitHubPR: 42
    })

    expect(updated.linkedPR).toBe(42)
    expect(updated.suppressedGitHubPR).toBeNull()
  })

  it('preserves suppression for clears and unrelated metadata updates', () => {
    expect(mergeWorktreeMetaForWrite(existingMeta, { linkedPR: null }).suppressedGitHubPR).toBe(42)
    expect(mergeWorktreeMetaForWrite(existingMeta, { comment: 'note' }).suppressedGitHubPR).toBe(42)
  })
})

describe('linked issue snapshot invalidation', () => {
  const SNAPSHOT = {
    version: 1 as const,
    number: 24,
    title: 'feat: inject linked issue',
    url: 'https://github.com/runrunliuliu/swarm-orca/issues/24',
    updatedAt: '2026-11-18T10:00:00Z',
    capturedAt: 1_700_000_000_000,
    body: '## Background'
  }

  it('drops the cached snapshot when the issue is unlinked', () => {
    const updated = mergeWorktreeMetaForWrite(
      { ...existingMeta, linkedIssue: 24, linkedIssueContext: SNAPSHOT },
      { linkedIssue: null }
    )

    expect(updated.linkedIssue).toBeNull()
    expect(updated.linkedIssueContext).toBeNull()
  })

  it('drops the cached snapshot when the link moves to another issue', () => {
    const updated = mergeWorktreeMetaForWrite(
      { ...existingMeta, linkedIssue: 24, linkedIssueContext: SNAPSHOT },
      { linkedIssue: 25 }
    )

    expect(updated.linkedIssue).toBe(25)
    expect(updated.linkedIssueContext).toBeNull()
  })

  it('keeps the snapshot when the same issue is written again', () => {
    const updated = mergeWorktreeMetaForWrite(
      { ...existingMeta, linkedIssue: 24, linkedIssueContext: SNAPSHOT },
      { linkedIssue: 24 }
    )

    expect(updated.linkedIssueContext).toEqual(SNAPSHOT)
  })

  it('keeps the snapshot for writes that do not touch the link', () => {
    const updated = mergeWorktreeMetaForWrite(
      { ...existingMeta, linkedIssue: 24, linkedIssueContext: SNAPSHOT },
      { comment: 'renamed' }
    )

    expect(updated.linkedIssueContext).toEqual(SNAPSHOT)
  })

  it('does not retire the snapshot when the write carries no link change', () => {
    const updated = mergeWorktreeMetaForWrite(
      { ...existingMeta, linkedIssue: 24, linkedIssueContext: SNAPSHOT },
      { linkedIssue: undefined }
    )

    // Why assert the link too: the generic merge spreads the key, so `undefined` overwrites the
    // stored number (pre-existing behaviour). The snapshot surviving is what this rule decides, and
    // the projection reads that missing number as "unlinked", so the block is still not injected.
    expect(updated.linkedIssue).toBeUndefined()
    expect(updated.linkedIssueContext).toEqual(SNAPSHOT)
  })

  it('lets a capture write the snapshot without a link update', () => {
    const updated = mergeWorktreeMetaForWrite(
      { ...existingMeta, linkedIssue: 24, linkedIssueContext: null },
      { linkedIssueContext: SNAPSHOT }
    )

    expect(updated.linkedIssueContext).toEqual(SNAPSHOT)
  })
})
