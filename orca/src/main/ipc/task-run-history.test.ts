import { describe, expect, it, vi } from 'vitest'
import type { TaskRunHistoryRecord } from '../../shared/task-run-history'
import { registerTaskRunHistoryHandlers } from './task-run-history'

const removeHandler = vi.fn()
const handle = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => removeHandler(channel),
    handle: (channel: string, handler: unknown) => handle(channel, handler)
  }
}))

function taskRecord(): TaskRunHistoryRecord {
  return {
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
}

describe('taskRunHistory:get', () => {
  it('returns the ledger rows for the exact task', () => {
    const record = taskRecord()
    const getTaskRunHistoryForTask = vi.fn().mockReturnValue({ state: {}, records: [record] })
    registerTaskRunHistoryHandlers({ getTaskRunHistoryForTask } as never)

    expect(removeHandler).toHaveBeenCalledWith('taskRunHistory:get')
    const handler = handle.mock.calls.find(([channel]) => channel === 'taskRunHistory:get')?.[1] as
      | ((event: unknown, args: unknown) => unknown)
      | undefined

    expect(
      handler?.(null, { repoId: 'repo-1', itemType: 'issue', number: 31 })
    ).toEqual({ records: [record] })
    expect(getTaskRunHistoryForTask).toHaveBeenCalledWith({
      repoId: 'repo-1',
      itemType: 'issue',
      number: 31
    })
  })

  it('answers an empty ledger for a malformed query instead of throwing', () => {
    registerTaskRunHistoryHandlers({ getTaskRunHistoryForTask: vi.fn() } as never)
    const handler = handle.mock.calls.at(-1)?.[1] as (event: unknown, args: unknown) => unknown

    expect(handler(null, { repoId: 'repo-1', itemType: 'pr', number: '31' })).toEqual({
      records: []
    })
    expect(handler(null, null)).toEqual({ records: [] })
  })
})
