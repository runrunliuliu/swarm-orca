import { describe, expect, it } from 'vitest'
import {
  EMPTY_TASK_RUN_HISTORY,
  normalizeTaskRunHistory,
  TASK_RUN_HISTORY_MAX_DELETED_RECORDS
} from './task-run-history'

/** The ledger is a legacy input now (issue #36 replaced it with `taskRecords`),
 *  so the only behaviour left to pin is the load-boundary normalization the
 *  one-time migration reads. */

describe('legacy task run history normalization', () => {
  it('keeps a well-formed row and its lifecycle timestamps', () => {
    const state = normalizeTaskRunHistory({
      version: 1,
      records: [
        {
          repoId: 'repo-1',
          itemType: 'issue',
          number: 31,
          worktreeId: 'repo-1::/repo/feature',
          path: '/repo/feature',
          state: 'deleted',
          firstSeenAt: 1,
          updatedAt: 2,
          deletedAt: 2
        }
      ]
    })

    expect(state.records).toEqual([
      expect.objectContaining({ worktreeId: 'repo-1::/repo/feature', deletedAt: 2 })
    ])
  })

  it('returns the empty ledger for a payload that is not an object', () => {
    expect(normalizeTaskRunHistory(null)).toBe(EMPTY_TASK_RUN_HISTORY)
    expect(normalizeTaskRunHistory({ records: 'nope' })).toBe(EMPTY_TASK_RUN_HISTORY)
  })

  it('drops a malformed row instead of guessing its fields', () => {
    const state = normalizeTaskRunHistory({
      version: 1,
      records: [
        { repoId: 'repo-1', itemType: 'issue', number: 31, worktreeId: 'repo-1::/p', path: '/p', state: 'moved', firstSeenAt: 1, updatedAt: 1 },
        {
          repoId: 'repo-1',
          itemType: 'pr',
          number: 9,
          worktreeId: 'repo-1::/repo/pr',
          path: '/repo/pr',
          state: 'active',
          firstSeenAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(state.records.map((record) => record.itemType)).toEqual(['pr'])
  })

  it('keeps the deleted cap so a migrated profile cannot grow past it', () => {
    const state = normalizeTaskRunHistory({
      version: 1,
      records: Array.from({ length: TASK_RUN_HISTORY_MAX_DELETED_RECORDS + 5 }, (_, index) => ({
        repoId: 'repo-1',
        itemType: 'issue',
        number: index + 1,
        worktreeId: `repo-1::/repo/w${index}`,
        path: `/repo/w${index}`,
        state: 'deleted',
        firstSeenAt: index,
        updatedAt: index,
        deletedAt: index
      }))
    })

    expect(state.records).toHaveLength(TASK_RUN_HISTORY_MAX_DELETED_RECORDS)
    expect(state.records[0].number).toBe(TASK_RUN_HISTORY_MAX_DELETED_RECORDS + 5)
  })
})
