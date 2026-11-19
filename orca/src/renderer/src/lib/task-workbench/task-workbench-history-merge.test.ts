import { describe, expect, it } from 'vitest'
import type { TaskRunHistoryRecord } from '../../../../shared/task-run-history'
import type { TaskWorkbenchHistory } from '@/components/task-workbench/task-workbench-view'
import { mergeTaskRunHistory } from './task-workbench-history-merge'

const HISTORY: TaskWorkbenchHistory = {
  agents: 2,
  wall: { kind: 'measured', startedAt: 1_000, endedAt: 2_000 },
  tokens: { kind: 'available', tokens: 1_320_000 },
  lastActivityAt: 2_000,
  archivedWorkspaces: 0,
  deletedWorkspaces: 0,
  trace: 'none',
  runs: []
}

function record(state: TaskRunHistoryRecord['state']): TaskRunHistoryRecord {
  return {
    repoId: 'repo-1',
    itemType: 'issue',
    number: 31,
    worktreeId: 'repo-1::/repo/feature',
    path: '/repo/feature',
    state,
    firstSeenAt: 1_000,
    updatedAt: 2_000
  }
}

describe('mergeTaskRunHistory', () => {
  it('leaves a task without deleted records exactly as the join reported it', () => {
    expect(mergeTaskRunHistory({ history: HISTORY, worktreeCount: 1, records: [] })).toBe(HISTORY)
    expect(
      mergeTaskRunHistory({ history: HISTORY, worktreeCount: 1, records: [record('archived')] })
    ).toBe(HISTORY)
  })

  it('keeps the archived answer and only records the deleted count', () => {
    const archivedHistory = { ...HISTORY, trace: 'archived' as const, archivedWorkspaces: 1 }
    expect(
      mergeTaskRunHistory({
        history: archivedHistory,
        worktreeCount: 1,
        records: [record('deleted')]
      })
    ).toEqual({ ...archivedHistory, deletedWorkspaces: 1 })
  })

  it('states the deleted form when no workspace row is left, with unknown facts', () => {
    const merged = mergeTaskRunHistory({
      history: HISTORY,
      worktreeCount: 0,
      records: [record('deleted'), { ...record('deleted'), worktreeId: 'repo-1::/repo/other' }]
    })

    expect(merged).toEqual(
      expect.objectContaining({
        agents: null,
        wall: { kind: 'unknown' },
        tokens: { kind: 'unavailable', reason: 'unattributed' },
        deletedWorkspaces: 2,
        trace: 'deleted',
        runs: []
      })
    )
    // An unknown fact is not a measured zero.
    expect(merged.agents).not.toBe(0)
  })
})
