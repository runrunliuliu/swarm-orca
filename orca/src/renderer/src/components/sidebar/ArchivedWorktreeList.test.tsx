// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import ArchivedWorktreeList from './ArchivedWorktreeList'

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo-1::/repo/feature',
    repoId: 'repo-1',
    path: '/repo/feature',
    head: 'abc',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Feature task',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

const INITIAL_WORKTREES = [
  worktree({ id: 'repo-1::/repo/main', path: '/repo/main', isMainWorktree: true }),
  worktree({ isArchived: true })
]

const state = {
  worktreesByRepo: { 'repo-1': INITIAL_WORKTREES },
  updateWorktreeMeta: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace('{{value0}}', String(options?.value0 ?? ''))
}))

beforeEach(() => {
  state.worktreesByRepo = { 'repo-1': INITIAL_WORKTREES }
})

afterEach(() => {
  cleanup()
  state.updateWorktreeMeta.mockReset()
})

describe('ArchivedWorktreeList', () => {
  it('lists only archived workspaces and restores one by clearing the flag', async () => {
    state.updateWorktreeMeta.mockResolvedValue({ ok: true })
    render(<ArchivedWorktreeList repo={REPO} />)

    expect(screen.getByText('Archived workspaces (1)')).toBeTruthy()
    expect(screen.queryByText('repo-1::/repo/main')).toBeNull()
    expect(screen.getByText('/repo/feature')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore Feature task' }))

    await waitFor(() =>
      expect(state.updateWorktreeMeta).toHaveBeenCalledWith(
        'repo-1::/repo/feature',
        { isArchived: false },
        { executionHostId: 'local' }
      )
    )
  })

  it('renders nothing when the repo has no archived workspace', () => {
    const archived = state.worktreesByRepo['repo-1'][1]
    state.worktreesByRepo = {
      'repo-1': [{ ...archived, isArchived: false }]
    } as typeof state.worktreesByRepo
    const view = render(<ArchivedWorktreeList repo={REPO} />)
    expect(view.container.textContent).toBe('')
  })
})
