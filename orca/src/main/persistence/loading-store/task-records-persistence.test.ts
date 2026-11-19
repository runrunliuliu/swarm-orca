import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { TaskRecordsRuntime } from './task-records-persistence'
import type { TaskRecordsUsageSource } from '../../task-records/task-records-worktree-usage'
import {
  recordTaskRecordsForWorktreeMeta,
  settleTaskRecordsBeforeRemoval,
  taskRecordForTask
} from './task-records-persistence'

const ID = 'repo-1::/repo/feature'
const QUERY = { repoId: 'repo-1', itemType: 'issue' as const, number: 31 }

function runtime(source: TaskRecordsUsageSource | null = null): TaskRecordsRuntime {
  return { state: { taskRecords: undefined }, taskRecordsUsageSource: source }
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

const SOURCE: TaskRecordsUsageSource = {
  snapshotForRemoval: () => ({
    settlement: {
      kind: 'known',
      collectedAt: 500,
      scope: 'worktree-rollup',
      worktreeId: ID,
      providers: [{ provider: 'claude', tokens: 900, costUsd: 0.1 }],
      estimatedCostUsd: 0.1
    },
    sessions: [
      { provider: 'claude', key: 'session_id', id: 'abc', firstSeenAt: 500, lastSeenAt: 500 }
    ]
  })
}

describe('task records persistence', () => {
  it('records the binding from the metadata row', () => {
    const state = runtime()
    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta())).toBe(true)

    const record = taskRecordForTask(state.state.taskRecords, QUERY)
    expect(record?.bindings).toEqual([
      expect.objectContaining({ worktreeId: ID, path: '/repo/feature', isArchived: false })
    ])
  })

  it('does not write for an unrelated metadata edit', () => {
    const state = runtime()
    recordTaskRecordsForWorktreeMeta(state, ID, meta())
    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta({ comment: 'note' }))).toBe(false)
  })

  it('marks the binding archived when the workspace is archived', () => {
    const state = runtime()
    recordTaskRecordsForWorktreeMeta(state, ID, meta())
    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))).toBe(true)
    expect(taskRecordForTask(state.state.taskRecords, QUERY)?.bindings[0].isArchived).toBe(true)
  })

  it('settles the removed binding and keeps the record (the issue #36 case)', () => {
    const state = runtime(SOURCE)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())

    expect(settleTaskRecordsBeforeRemoval(state, null, ID, 500)).toBe(true)

    const record = taskRecordForTask(state.state.taskRecords, QUERY)
    expect(record?.bindings).toHaveLength(1)
    expect(record?.bindings[0].usageSettlement).toMatchObject({ kind: 'known' })
    expect(record?.bindings[0].sessions).toEqual([
      expect.objectContaining({ id: 'abc', key: 'session_id' })
    ])
  })

  it('settles nothing when no usage source is bound (a startup-order gap, not a zero)', () => {
    const state = runtime(null)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())
    expect(settleTaskRecordsBeforeRemoval(state, null, ID, 500)).toBe(false)
    expect(
      taskRecordForTask(state.state.taskRecords, QUERY)?.bindings[0].usageSettlement
    ).toBeUndefined()
  })

  it('never throws when the usage source fails, so a removal is not blocked', () => {
    const failing: TaskRecordsUsageSource = {
      snapshotForRemoval: () => {
        throw new Error('scan unavailable')
      }
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const state = runtime(failing)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())

    expect(settleTaskRecordsBeforeRemoval(state, null, ID, 500)).toBe(false)
    expect(
      taskRecordForTask(state.state.taskRecords, QUERY)?.bindings[0].usageSettlement
    ).toBeUndefined()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('refuses to touch a domain this build cannot read', () => {
    // A payload from a build that knows a newer records version.
    const state: TaskRecordsRuntime = {
      state: { taskRecords: { recordsVersion: 2, byId: {}, externalIndex: {} } },
      taskRecordsUsageSource: SOURCE
    }

    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta())).toBe(false)
    expect(settleTaskRecordsBeforeRemoval(state, null, ID, 500)).toBe(false)
    expect(state.state.taskRecords).toEqual({ recordsVersion: 2, byId: {}, externalIndex: {} })
  })
})
