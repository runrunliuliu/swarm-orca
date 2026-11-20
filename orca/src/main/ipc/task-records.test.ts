import { describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../shared/task-records-types'
import { registerTaskRecordHandlers, isTaskRecordQuery } from './task-records'

type Handler = (event: unknown, args: unknown) => { record: TaskRecord | null }

const handlers = new Map<string, Handler>()
const removed: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => {
      removed.push(channel)
    },
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }
  }
}))

function registered(): Handler {
  const handler = handlers.get('taskRecords:get')
  if (!handler) {
    throw new Error('taskRecords:get was not registered')
  }
  return handler
}

function record(): TaskRecord {
  return {
    taskId: 'task:repo-1:issue:31',
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    bindings: [],
    intent: {},
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1
  }
}

describe('taskRecords:get', () => {
  it('answers with the record of the exact task', () => {
    const task = record()
    const getTaskRecordForTask = vi.fn<(args: unknown) => TaskRecord | null>(() => task)
    registerTaskRecordHandlers({ getTaskRecordForTask })

    expect(removed).toContain('taskRecords:get')
    expect(registered()(null, { repoId: 'repo-1', itemType: 'issue', number: 31 })).toEqual({
      record: task
    })
    expect(getTaskRecordForTask).toHaveBeenCalledWith({
      repoId: 'repo-1',
      itemType: 'issue',
      number: 31
    })
  })

  it.each([
    null,
    undefined,
    {},
    { repoId: '', itemType: 'issue', number: 31 },
    { repoId: 'repo-1', itemType: 'pull', number: 31 },
    { repoId: 'repo-1', itemType: 'issue', number: 3.5 },
    { repoId: 'repo-1', itemType: 'issue' },
    { repoId: 'repo-1', itemType: 'issue', number: 31, provider: 'bitbucket' }
  ])('answers null instead of throwing for a malformed query %#', (args) => {
    const getTaskRecordForTask = vi.fn<(input: unknown) => TaskRecord | null>(() => null)
    registerTaskRecordHandlers({ getTaskRecordForTask })

    expect(registered()(null, args)).toEqual({ record: null })
    expect(getTaskRecordForTask).not.toHaveBeenCalled()
  })

  it('validates the query shape', () => {
    expect(isTaskRecordQuery({ repoId: 'repo-1', itemType: 'pr', number: 9 })).toBe(true)
    expect(
      isTaskRecordQuery({ provider: 'linear', repoId: 'repo-1', itemType: 'issue', number: 9 })
    ).toBe(true)
    expect(isTaskRecordQuery({ repoId: 'repo-1', itemType: 'pr', number: Number.NaN })).toBe(false)
  })
})
