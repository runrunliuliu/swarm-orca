import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { StoreRuntimeState } from './store-runtime-state'
import {
  recordTaskRunLinks,
  recordTaskRunWorktreeDeleted
} from './task-run-history-persistence'

function runtime(): Pick<StoreRuntimeState, 'state'> {
  return { state: { taskRunHistory: undefined } } as unknown as Pick<StoreRuntimeState, 'state'>
}

function meta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'Feature',
    comment: '',
    linkedIssue: 31,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 10,
    ...overrides
  }
}

const ID = 'repo-1::/repo/feature'

describe('task run history persistence', () => {
  it('records the GitHub issue link from the metadata row', () => {
    const state = runtime()
    expect(recordTaskRunLinks(state, ID, meta(), { now: 100 })).toBe(true)

    expect(state.state.taskRunHistory?.records).toEqual([
      expect.objectContaining({
        repoId: 'repo-1',
        itemType: 'issue',
        number: 31,
        worktreeId: ID,
        path: '/repo/feature',
        state: 'active',
        firstSeenAt: 100
      })
    ])
  })

  it('records an issue and a PR as separate tasks', () => {
    const state = runtime()
    recordTaskRunLinks(state, ID, meta({ linkedPR: 9 }), { now: 100 })
    expect(state.state.taskRunHistory?.records.map((record) => record.itemType)).toEqual([
      'issue',
      'pr'
    ])
  })

  it('does not record an unlinked worktree', () => {
    const state = runtime()
    expect(
      recordTaskRunLinks(state, ID, meta({ linkedIssue: null, linkedPR: null }), { now: 100 })
    ).toBe(false)
    expect(state.state.taskRunHistory).toBeUndefined()
  })

  it('seeds a deleted record from the last metadata row when the ledger missed it', () => {
    const state = runtime()
    expect(recordTaskRunWorktreeDeleted(state, ID, meta(), 200)).toBe(true)
    expect(state.state.taskRunHistory?.records[0]).toEqual(
      expect.objectContaining({ state: 'deleted', deletedAt: 200 })
    )
  })

  it('marks an existing active record deleted instead of dropping it', () => {
    const state = runtime()
    recordTaskRunLinks(state, ID, meta(), { now: 100 })
    expect(recordTaskRunWorktreeDeleted(state, ID, meta(), 200)).toBe(true)
    expect(state.state.taskRunHistory?.records[0]).toEqual(
      expect.objectContaining({ state: 'deleted', firstSeenAt: 100, deletedAt: 200 })
    )
  })
})
