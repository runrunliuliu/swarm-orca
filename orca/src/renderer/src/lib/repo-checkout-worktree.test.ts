import { describe, expect, it } from 'vitest'

import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { findRepoCheckoutWorktree } from './repo-checkout-worktree'

describe('findRepoCheckoutWorktree', () => {
  it('returns the repo checkout, not a branch worktree', () => {
    const checkout = makeWorktree({ id: 'wt-main', repoId: 'repo-1', isMainWorktree: true })
    const branch = makeWorktree({ id: 'wt-branch', repoId: 'repo-1' })
    expect(
      findRepoCheckoutWorktree({ 'repo-1': [branch, checkout] }, 'repo-1')?.id
    ).toBe('wt-main')
  })

  it('returns null when the repo has no checkout on this host', () => {
    const branch = makeWorktree({ id: 'wt-branch', repoId: 'repo-1' })
    expect(findRepoCheckoutWorktree({ 'repo-1': [branch] }, 'repo-1')).toBeNull()
  })

  it('returns null for a repo the listing has not landed for yet', () => {
    expect(findRepoCheckoutWorktree({}, 'repo-missing')).toBeNull()
  })
})
