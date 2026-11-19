import { describe, expect, it } from 'vitest'
import type {
  TaskRecord,
  TaskUsageSettlement,
  TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import type { TaskWorkbenchHistory } from '@/components/task-workbench/task-workbench-view'
import { mergeTaskRecordHistory } from './task-workbench-history-merge'

const HISTORY: TaskWorkbenchHistory = {
  agents: 2,
  wall: { kind: 'measured', startedAt: 1_000, endedAt: 2_000 },
  tokens: { kind: 'available', tokens: 1_320_000 },
  lastActivityAt: 2_000,
  archivedWorkspaces: 0,
  deletedWorkspaces: 0,
  tokensSource: 'live',
  workspaces: [],
  sessions: [],
  trace: 'none',
  runs: []
}

function binding(
  worktreeId: string,
  overrides: Partial<TaskWorkspaceBinding> = {}
): TaskWorkspaceBinding {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId: 'local',
    path: `/repo/${worktreeId}`,
    isArchived: false,
    boundAt: 1_000,
    boundBy: 'created',
    lastVerifiedAt: 2_000,
    resolvedVia: 'locator',
    sessions: [],
    ...overrides
  }
}

function record(bindings: TaskWorkspaceBinding[]): TaskRecord {
  return {
    taskId: 'task:repo-1:issue:31',
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    bindings,
    intent: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    schemaVersion: 1
  }
}

function settlement(
  worktreeId: string,
  value: TaskUsageSettlement = {
    kind: 'known',
    collectedAt: 3_000,
    scope: 'worktree-rollup',
    worktreeId,
    providers: [{ provider: 'claude', tokens: 420_000, costUsd: 0.7 }],
    estimatedCostUsd: 0.7
  }
): TaskUsageSettlement {
  return value
}

describe('mergeTaskRecordHistory', () => {
  it('leaves a task whose workspaces all still exist exactly as the join reported it', () => {
    expect(
      mergeTaskRecordHistory({
        history: HISTORY,
        existingWorktreeIds: ['wt-feature'],
        record: record([binding('wt-feature')])
      })
    ).toBe(HISTORY)
  })

  it('states the deleted form when no workspace is left, and keeps the unknown facts unknown', () => {
    const merged = mergeTaskRecordHistory({
      history: {
        ...HISTORY,
        agents: null,
        tokens: { kind: 'unavailable', reason: 'unattributed' }
      },
      existingWorktreeIds: [],
      record: record([binding('wt-feature'), binding('wt-other')])
    })

    expect(merged).toEqual(
      expect.objectContaining({
        deletedWorkspaces: 2,
        trace: 'deleted',
        agents: null,
        wall: { kind: 'unknown' },
        runs: []
      })
    )
    expect(merged.workspaces.map((workspace) => workspace.state)).toEqual(['removed', 'removed'])
  })

  it('labels a live archived workspace as archived, not removed', () => {
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: ['wt-feature'],
      record: record([binding('wt-feature', { isArchived: true }), binding('wt-gone')])
    })

    expect(merged.workspaces).toEqual([
      expect.objectContaining({ worktreeId: 'wt-feature', state: 'archived' }),
      expect.objectContaining({ worktreeId: 'wt-gone', state: 'removed' })
    ])
    expect(merged.archivedWorkspaces).toBe(1)
    expect(merged.deletedWorkspaces).toBe(1)
  })

  it('uses the settled figures for removed workspaces and marks the source', () => {
    const merged = mergeTaskRecordHistory({
      history: {
        ...HISTORY,
        agents: null,
        tokens: { kind: 'unavailable', reason: 'unattributed' }
      },
      existingWorktreeIds: [],
      record: record([
        binding('wt-feature', { usageSettlement: settlement('wt-feature') }),
        binding('wt-gone', {
          usageSettlement: settlement('wt-gone', {
            kind: 'known',
            collectedAt: 3_000,
            scope: 'worktree-rollup',
            worktreeId: 'wt-gone',
            providers: [{ provider: 'codex', tokens: 80_000, costUsd: null }],
            estimatedCostUsd: null
          })
        })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'available', tokens: 500_000 })
    expect(merged.tokensSource).toBe('settled')
  })

  it('does not turn a missing settlement into zero tokens', () => {
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: [],
      record: record([
        binding('wt-feature', { usageSettlement: settlement('wt-feature') }),
        binding('wt-gone', {
          usageSettlement: {
            kind: 'unavailable',
            collectedAt: 3_000,
            scope: 'worktree-rollup',
            worktreeId: 'wt-gone',
            reason: 'no_matching_session'
          }
        })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'unavailable', reason: 'no_matching_session' })
    expect(merged.tokensSource).toBe('settled')
  })

  it('adds a live total and a settled total only when both are known', () => {
    const live = { ...HISTORY, tokens: { kind: 'available' as const, tokens: 100 } }
    const merged = mergeTaskRecordHistory({
      history: live,
      existingWorktreeIds: ['wt-live'],
      record: record([
        binding('wt-live'),
        binding('wt-gone', { usageSettlement: settlement('wt-gone') })
      ])
    })
    // 100 live + 420_000 settled: the panel says "Total: every run", so a total
    // that covered only one side would be wrong.
    expect(merged.tokens).toEqual({ kind: 'available', tokens: 420_100 })
    expect(merged.tokensSource).toBe('settled')
  })

  it('reports an unknown combined total instead of half of it', () => {
    const merged = mergeTaskRecordHistory({
      history: { ...HISTORY, tokens: { kind: 'unavailable', reason: 'unattributed' } },
      existingWorktreeIds: ['wt-live'],
      record: record([
        binding('wt-live'),
        binding('wt-gone', { usageSettlement: settlement('wt-gone') })
      ])
    })

    expect(merged.tokens).toEqual({ kind: 'unavailable', reason: 'unattributed' })
  })

  it('does not call a workspace removed just because it left this task', () => {
    // Still on disk, no longer linked to this task: presence is not provenance.
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: ['wt-other-task'],
      record: record([binding('wt-feature')])
    })

    expect(merged.workspaces).toEqual([expect.objectContaining({ state: 'removed' })])
    expect(
      mergeTaskRecordHistory({
        history: HISTORY,
        existingWorktreeIds: ['wt-feature', 'wt-other-task'],
        record: record([binding('wt-feature')])
      })
    ).toBe(HISTORY)
  })

  it('keeps every recorded session addressable but never resumable', () => {
    const merged = mergeTaskRecordHistory({
      history: HISTORY,
      existingWorktreeIds: [],
      record: record([
        binding('wt-gone', {
          sessions: [
            {
              provider: 'claude',
              key: 'session_id',
              id: 'abc',
              transcriptPath: '/home/u/.claude/abc.jsonl',
              firstSeenAt: 1_000,
              lastSeenAt: 2_000
            },
            {
              key: 'session_file',
              id: 'pi-1',
              firstSeenAt: 1_000,
              lastSeenAt: 2_000
            }
          ]
        })
      ])
    })

    expect(merged.sessions).toEqual([
      {
        key: 'claude|session_id:abc',
        provider: 'claude',
        hasTranscriptPath: true,
        resumable: false,
        worktreeId: 'wt-gone'
      },
      {
        key: 'unknown|session_file:pi-1',
        hasTranscriptPath: false,
        resumable: false,
        worktreeId: 'wt-gone'
      }
    ])
  })
})
