import { describe, expect, it } from 'vitest'
import {
  EMPTY_TASK_RUN_HISTORY,
  markTaskRunHistoryDeleted,
  normalizeTaskRunHistory,
  TASK_RUN_HISTORY_MAX_DELETED_RECORDS,
  taskRunHistoryForTask,
  upsertTaskRunHistoryRecord
} from './task-run-history'

const NOW = 1_000

function input(overrides: Partial<Parameters<typeof upsertTaskRunHistoryRecord>[1]> = {}) {
  return {
    repoId: 'repo-1',
    itemType: 'issue' as const,
    number: 31,
    worktreeId: 'repo-1::/repo/feature',
    state: 'active' as const,
    now: NOW,
    ...overrides
  }
}

describe('task run history ledger', () => {
  it('records an active worktree and keeps the path from the locator id', () => {
    const { state, changed } = upsertTaskRunHistoryRecord(EMPTY_TASK_RUN_HISTORY, input())

    expect(changed).toBe(true)
    expect(state.records).toEqual([
      expect.objectContaining({
        repoId: 'repo-1',
        itemType: 'issue',
        number: 31,
        worktreeId: 'repo-1::/repo/feature',
        path: '/repo/feature',
        state: 'active',
        firstSeenAt: NOW
      })
    ])
  })

  it('does not schedule a write for an unchanged comment/pin update', () => {
    const first = upsertTaskRunHistoryRecord(EMPTY_TASK_RUN_HISTORY, input())
    const second = upsertTaskRunHistoryRecord(first.state, input({ now: NOW + 10 }))

    expect(second.changed).toBe(false)
    expect(second.state).toBe(first.state)
  })

  it('archives then deletes without dropping the identity', () => {
    const active = upsertTaskRunHistoryRecord(EMPTY_TASK_RUN_HISTORY, input())
    const archived = upsertTaskRunHistoryRecord(
      active.state,
      input({ state: 'archived', now: NOW + 10 })
    )
    const deleted = markTaskRunHistoryDeleted(archived.state, 'repo-1::/repo/feature', NOW + 20)

    expect(deleted.changed).toBe(true)
    expect(deleted.state.records[0]).toEqual(
      expect.objectContaining({
        state: 'deleted',
        archivedAt: NOW + 10,
        deletedAt: NOW + 20,
        path: '/repo/feature'
      })
    )
  })

  it('filters by repo, item type and number, never by number alone', () => {
    const one = upsertTaskRunHistoryRecord(EMPTY_TASK_RUN_HISTORY, input())
    const two = upsertTaskRunHistoryRecord(
      one.state,
      input({ repoId: 'repo-2', worktreeId: 'repo-2::/repo/feature' })
    )
    const pr = upsertTaskRunHistoryRecord(
      two.state,
      input({ itemType: 'pr', worktreeId: 'repo-1::/repo/pr' })
    )

    expect(taskRunHistoryForTask(pr.state, { repoId: 'repo-1', itemType: 'issue', number: 31 })).toHaveLength(1)
    expect(taskRunHistoryForTask(pr.state, { repoId: 'repo-1', itemType: 'pr', number: 31 })).toHaveLength(1)
    expect(taskRunHistoryForTask(pr.state, { repoId: 'repo-2', itemType: 'issue', number: 31 })).toHaveLength(1)
  })

  it('drops malformed rows on load instead of inventing a state', () => {
    expect(normalizeTaskRunHistory(undefined)).toEqual(EMPTY_TASK_RUN_HISTORY)
    expect(normalizeTaskRunHistory({ records: 'nope' })).toEqual(EMPTY_TASK_RUN_HISTORY)
    expect(
      normalizeTaskRunHistory({
        records: [
          { repoId: 'repo-1' },
          {
            repoId: 'repo-1',
            itemType: 'issue',
            number: 31,
            worktreeId: 'repo-1::/repo/feature',
            path: '/repo/feature',
            state: 'bogus',
            firstSeenAt: 1,
            updatedAt: 1
          }
        ]
      }).records
    ).toEqual([])
  })

  it('caps deleted records but keeps active worktrees', () => {
    let state = EMPTY_TASK_RUN_HISTORY
    for (let index = 0; index < TASK_RUN_HISTORY_MAX_DELETED_RECORDS + 5; index += 1) {
      state = upsertTaskRunHistoryRecord(state, {
        ...input({
          worktreeId: `repo-1::/repo/deleted-${index}`,
          state: 'deleted',
          now: NOW + index
        })
      }).state
    }
    state = upsertTaskRunHistoryRecord(state, {
      ...input({ worktreeId: 'repo-1::/repo/live', state: 'active', now: NOW + 10_000 })
    }).state

    const deleted = state.records.filter((record) => record.state === 'deleted')
    expect(deleted).toHaveLength(TASK_RUN_HISTORY_MAX_DELETED_RECORDS)
    expect(state.records.some((record) => record.worktreeId === 'repo-1::/repo/live')).toBe(true)
  })
})
