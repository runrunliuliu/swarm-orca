// Adoption keeps provenance honest: the row gains identity and lifecycle fields, and never claims
// Orca created the checkout or owns its branch.
import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  adoptExternalWorktreesForListing,
  externalWorktreeAdoptionMeta,
  selectWorktreesToAdopt
} from './external-worktree-adoption'

const worktree = (path: string, branch = 'feature/x', isMainWorktree = false) => ({
  path,
  branch: `refs/heads/${branch}`,
  isMainWorktree
})

function storeWith(existing: Record<string, WorktreeMeta> = {}) {
  const written: [string, Partial<WorktreeMeta>][] = []
  return {
    written,
    getWorktreeMeta: (id: string) => existing[id],
    setWorktreeMeta: vi.fn((id: string, meta: Partial<WorktreeMeta>) => {
      written.push([id, meta])
      return meta
    })
  }
}

describe('externalWorktreeAdoptionMeta', () => {
  it('gives the row identity and lifecycle without claiming Orca created it', () => {
    const meta = externalWorktreeAdoptionMeta({
      worktree: worktree('/repo-wt', 'task-a'),
      now: 1_700_000_000_000,
      instanceId: 'instance-1'
    })

    expect(meta).toEqual({
      instanceId: 'instance-1',
      displayName: 'task-a',
      createdAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_000_000,
      orcaCreationSource: 'external',
      preserveBranchOnDelete: true
    })
    // Why explicit: `orcaCreatedAt` is the "Orca made this" stamp; an adopted checkout must not get it.
    expect(meta).not.toHaveProperty('orcaCreatedAt')
  })

  it('keeps a user-authored display name when one is supplied', () => {
    const meta = externalWorktreeAdoptionMeta({
      worktree: worktree('/repo-wt', 'task-a'),
      now: 1,
      existingDisplayName: 'My hotfix'
    })
    expect(meta.displayName).toBe('My hotfix')
  })
})

describe('selectWorktreesToAdopt', () => {
  it('skips rows that already have metadata and the repository checkout itself', () => {
    const selected = selectWorktreesToAdopt({
      repoId: 'repo-1',
      hostId: 'local',
      worktrees: [worktree('/repo', 'main', true), worktree('/a'), worktree('/b')],
      readMeta: (id) => (id.endsWith('/a') ? ({ displayName: 'a' } as WorktreeMeta) : undefined)
    })

    expect(selected.map((entry) => entry.path)).toEqual(['/b'])
  })

  it('is bounded so one listing cannot rewrite a whole catalog', () => {
    const many = Array.from({ length: 10 }, (_, index) => worktree(`/wt-${index}`))
    expect(
      selectWorktreesToAdopt({
        repoId: 'repo-1',
        hostId: 'local',
        worktrees: many,
        readMeta: () => undefined,
        limit: 3
      })
    ).toHaveLength(3)
  })
})

describe('adoptExternalWorktreesForListing', () => {
  it('adopts each unadopted row once', () => {
    const store = storeWith()
    const worktrees = [worktree('/wt-a'), worktree('/wt-b')]

    expect(
      adoptExternalWorktreesForListing({ repoId: 'repo-1', hostId: 'local', worktrees, store, now: 5 })
    ).toEqual(['repo-1::/wt-a', 'repo-1::/wt-b'])
    expect(store.written).toHaveLength(2)
    expect(store.written[0]?.[1]).toMatchObject({ orcaCreationSource: 'external', createdAt: 5 })
  })

  it('does not adopt again once the row exists', () => {
    const store = storeWith({ 'repo-1::/wt-a': { displayName: 'a' } as WorktreeMeta })

    expect(
      adoptExternalWorktreesForListing({
        repoId: 'repo-1',
        hostId: 'local',
        worktrees: [worktree('/wt-a')],
        store,
        now: 5
      })
    ).toEqual([])
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('keeps the listing usable when one row cannot be written', () => {
    const store = {
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn((id: string) => {
        if (id.endsWith('/bad')) {
          throw new Error('disk full')
        }
        return {}
      })
    }

    expect(
      adoptExternalWorktreesForListing({
        repoId: 'repo-1',
        hostId: 'local',
        worktrees: [worktree('/bad'), worktree('/good')],
        store,
        now: 5
      })
    ).toEqual(['repo-1::/good'])
  })
})
