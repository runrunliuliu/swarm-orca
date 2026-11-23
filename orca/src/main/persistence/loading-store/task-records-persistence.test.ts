import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { TASK_RECORDS_MAX_RECORD_BYTES } from '../../../shared/task-records-types'
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
  captureSessionsForRemoval: () => {},
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
      captureSessionsForRemoval: () => {},
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

  it('settles only the removed owner and reads one snapshot per owner', () => {
    const calls: { worktreeId: string; hostId: string }[] = []
    const perHost: TaskRecordsUsageSource = {
      captureSessionsForRemoval: () => {},
      snapshotForRemoval: ({ worktreeId, hostId, now }) => {
        calls.push({ worktreeId, hostId })
        return {
          settlement: {
            kind: 'known',
            collectedAt: now,
            scope: 'worktree-rollup',
            worktreeId,
            providers: [{ provider: 'claude', tokens: 1, costUsd: 0.1 }],
            estimatedCostUsd: 0.1
          },
          sessions: []
        }
      }
    }
    const state = runtime(perHost)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())
    recordTaskRecordsForWorktreeMeta(state, ID, meta({ hostId: 'ssh:remote-a' }))

    expect(settleTaskRecordsBeforeRemoval(state, null, ID, 600, 'ssh:remote-a')).toBe(true)
    expect(calls).toEqual([{ worktreeId: ID, hostId: 'ssh:remote-a' }])
    const bindings = taskRecordForTask(state.state.taskRecords, QUERY)?.bindings ?? []
    expect(bindings).toHaveLength(2)
    expect(bindings.find((binding) => binding.hostId === 'ssh:remote-a')?.usageSettlement).toMatchObject(
      { kind: 'known', collectedAt: 600 }
    )
    expect(
      bindings.find((binding) => binding.hostId === 'local')?.usageSettlement
    ).toBeUndefined()
  })

  it('settles every same-locator binding on a full removal', () => {
    const calls: string[] = []
    const perHost: TaskRecordsUsageSource = {
      captureSessionsForRemoval: () => {},
      snapshotForRemoval: ({ worktreeId, hostId, now }) => {
        calls.push(hostId)
        return {
          settlement: {
            kind: 'known',
            collectedAt: now,
            scope: 'worktree-rollup',
            worktreeId,
            providers: [{ provider: 'claude', tokens: 1, costUsd: 0.1 }],
            estimatedCostUsd: 0.1
          },
          sessions: []
        }
      }
    }
    const state = runtime(perHost)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())
    recordTaskRecordsForWorktreeMeta(state, ID, meta({ hostId: 'ssh:remote-a' }))

    expect(settleTaskRecordsBeforeRemoval(state, null, ID, 700)).toBe(true)
    expect(calls.sort()).toEqual(['local', 'ssh:remote-a'])
    const bindings = taskRecordForTask(state.state.taskRecords, QUERY)?.bindings ?? []
    expect(bindings).toHaveLength(2)
    for (const binding of bindings) {
      expect(binding.usageSettlement).toMatchObject({ kind: 'known', collectedAt: 700 })
    }
  })

  it('keeps two hosts bound to different tasks apart', () => {
    // The original regression: a host-qualified write read the first owner's
    // legacy projection and recorded that owner's task under the second host.
    const state = runtime()
    recordTaskRecordsForWorktreeMeta(state, ID, meta({ linkedIssue: 31 }))
    recordTaskRecordsForWorktreeMeta(
      state,
      ID,
      meta({ hostId: 'ssh:remote-a', linkedIssue: 32 })
    )

    const local = taskRecordForTask(state.state.taskRecords, QUERY)?.bindings ?? []
    const remote =
      taskRecordForTask(state.state.taskRecords, {
        ...QUERY,
        number: 32
      })?.bindings ?? []
    expect(local).toEqual([expect.objectContaining({ hostId: 'local' })])
    expect(remote).toEqual([expect.objectContaining({ hostId: 'ssh:remote-a' })])
  })

  it('seeds from the legacy ledger before the first write creates the domain', () => {
    const state: TaskRecordsRuntime = {
      state: {
        taskRunHistory: {
          version: 1,
          records: [
            {
              repoId: 'repo-1',
              itemType: 'issue',
              number: 31,
              worktreeId: 'repo-1::/repo/legacy',
              path: '/repo/legacy',
              state: 'active',
              firstSeenAt: 50,
              updatedAt: 60
            }
          ]
        }
      }
    }

    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta())).toBe(true)
    const bindings = taskRecordForTask(state.state.taskRecords, QUERY)?.bindings ?? []
    expect(bindings.map((binding) => binding.worktreeId).sort()).toEqual([
      'repo-1::/repo/feature',
      'repo-1::/repo/legacy'
    ])
  })

  it('does not create a domain when the legacy seed defers', () => {
    // A deferred seed must stay deferred: creating the domain here would persist
    // an empty "migrated" domain and the next start would never retry the ledger.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state: TaskRecordsRuntime = {
      state: {
        taskRunHistory: {
          version: 1,
          records: [
            {
              repoId: 'repo-1',
              itemType: 'issue',
              number: 31,
              worktreeId: 'repo-1::/repo/legacy',
              path: '/repo/legacy',
              state: 'active',
              firstSeenAt: 50,
              updatedAt: 60
            },
            {
              repoId: 'repo-1',
              itemType: 'issue',
              number: 32,
              worktreeId: 'repo-1::/repo/overflow',
              path: `/${'x'.repeat(TASK_RECORDS_MAX_RECORD_BYTES)}`,
              state: 'active',
              firstSeenAt: 50,
              updatedAt: 60
            }
          ]
        }
      }
    }

    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta())).toBe(false)
    expect(state.state.taskRecords).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy migration deferred'))
    warn.mockRestore()
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

/**
 * Issue #53 A: the archive transition. These drive the same seam both metadata
 * entry points reach (`worktrees:updateMeta` and RPC/CLI `worktree.set`), so what
 * is asserted here is the one write they share, not a transport.
 */
describe('task records archive snapshot', () => {
  /** Only `snapshotForRemoval`: this is also the compatibility path for a source
   *  written before issue #53, which has no capture-free archive entry. */
  const ARCHIVING: TaskRecordsUsageSource = {
    captureSessionsForRemoval: () => {},
    snapshotForRemoval: ({ now }) => ({
      settlement: {
        kind: 'known',
        collectedAt: now,
        scope: 'worktree-rollup',
        worktreeId: ID,
        providers: [{ provider: 'claude', tokens: 900, costUsd: 0.1 }],
        estimatedCostUsd: 0.1
      },
      sessions: [
        {
          provider: 'claude',
          key: 'session_id',
          id: 'abc',
          agentType: 'claude',
          startedAt: 400,
          endedAt: 450,
          firstSeenAt: now,
          lastSeenAt: now
        }
      ]
    })
  }

  const UNATTRIBUTED: TaskRecordsUsageSource = {
    captureSessionsForRemoval: () => {},
    snapshotForRemoval: ({ now }) => ({
      settlement: {
        kind: 'unavailable',
        collectedAt: now,
        scope: 'worktree-rollup',
        worktreeId: ID,
        reason: 'no_matching_session'
      },
      sessions: []
    })
  }

  function bindingsOf(state: TaskRecordsRuntime) {
    return taskRecordForTask(state.state.taskRecords, QUERY)?.bindings ?? []
  }

  it('writes sessions, a run and the settlement when the workspace is archived', () => {
    const state = runtime(ARCHIVING)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())

    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))).toBe(true)

    const [binding] = bindingsOf(state)
    expect(binding.isArchived).toBe(true)
    expect(binding.sessions).toEqual([
      expect.objectContaining({ id: 'abc', source: 'archive-snapshot', agentType: 'claude' })
    ])
    expect(binding.runs).toEqual([
      expect.objectContaining({
        key: 'claude|session_id:abc',
        source: 'archive-snapshot',
        startedAt: 400,
        endedAt: 450
      })
    ])
    expect(binding.usageSettlement).toMatchObject({ kind: 'known' })
    expect(binding.gaps).toBeUndefined()
  })

  it('leaves a gap instead of an empty authoritative list when nothing is attributable (T2)', () => {
    const state = runtime(UNATTRIBUTED)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())

    recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))

    const [binding] = bindingsOf(state)
    // `runs: []` = the writer looked; the gap says why it found nothing. A reader
    // must not turn that pair into "this workspace never ran an agent".
    expect(binding.runs).toEqual([])
    expect(binding.gaps).toEqual([
      expect.objectContaining({ kind: 'session_unattributable', observedAt: expect.any(Number) })
    ])
    expect(binding.sessions).toEqual([])
  })

  it('binds and snapshots in one write when the worktree had no prior binding', () => {
    const state = runtime(ARCHIVING)

    // Nothing bound this workspace before it was archived (a legacy worktree, or an
    // archive that arrives before its first metadata write).
    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))).toBe(true)

    const [binding] = bindingsOf(state)
    expect(binding).toMatchObject({ worktreeId: ID, isArchived: true })
    expect(binding.runs).toHaveLength(1)
    expect(binding.sessions).toHaveLength(1)
  })

  it('does not snapshot an archive of an already-archived row', () => {
    const state = runtime(ARCHIVING)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())
    recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))
    const [first] = bindingsOf(state)

    // The row is already archived: no state change, so no second irreversible
    // moment and no rewrite of the frozen rows.
    expect(recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))).toBe(false)

    expect(bindingsOf(state)[0]).toEqual(first)
  })

  it('snapshots again after an unarchive, upserting into the same claim keys', () => {
    // A distinct clock per step: the four writes would otherwise land in one
    // millisecond and the observation window could not move.
    vi.useFakeTimers()
    try {
      const state = runtime(ARCHIVING)
      vi.setSystemTime(1_000)
      recordTaskRecordsForWorktreeMeta(state, ID, meta())
      vi.setSystemTime(2_000)
      recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))
      const [first] = bindingsOf(state)
      const frozen = {
        recordedAt: first.runs?.[0].recordedAt,
        firstSeenAt: first.runs?.[0].firstSeenAt
      }

      // Unarchive, then archive again: a second transition, so the snapshot runs
      // again — as an *observation*, not a second row. Identity is the claim, so one
      // session stays one session and one run stays one run; provenance is
      // first-writer-wins, so the row still says it was frozen at the first archive.
      vi.setSystemTime(3_000)
      recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: false }))
      vi.setSystemTime(4_000)
      recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))

      const [second] = bindingsOf(state)
      expect(second.sessions).toHaveLength(1)
      expect(second.runs).toHaveLength(1)
      expect(second.runs?.[0].recordedAt).toBe(frozen.recordedAt)
      expect(second.runs?.[0].firstSeenAt).toBe(frozen.firstSeenAt)
      expect(second.runs?.[0].lastSeenAt).toBe(4_000)
      expect(second.sessions[0].lastSeenAt).toBe(4_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a recoverable gap, not an empty authoritative list, when no source is bound', () => {
    const state = runtime(null)
    recordTaskRecordsForWorktreeMeta(state, ID, meta())

    recordTaskRecordsForWorktreeMeta(state, ID, meta({ isArchived: true }))

    const [binding] = bindingsOf(state)
    expect(binding.isArchived).toBe(true)
    // The archive write ran without a source (the headless composition root): the
    // record says so instead of leaving `sessions: []` as its only statement, and
    // the gap names how to finish it. Nothing measured stays absent, never a zero.
    expect(binding.sessions).toEqual([])
    expect(binding.runs).toEqual([])
    expect(binding.gaps).toEqual([
      expect.objectContaining({
        kind: 'session_unattributable',
        detail: expect.stringContaining('orca history backfill')
      })
    ])
    expect(binding.usageSettlement).toBeUndefined()
  })
})
