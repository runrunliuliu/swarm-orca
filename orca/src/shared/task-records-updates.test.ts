import { describe, expect, it } from 'vitest'
import {
  mergeTaskRecordBindingSessions,
  setTaskRecordBindingSettlement,
  upsertTaskRecordBinding
} from './task-records-updates'
import {
  EMPTY_TASK_RECORDS,
  TASK_RECORDS_MAX_BINDINGS_PER_RECORD,
  TASK_RECORDS_MAX_DOMAIN_BYTES,
  TASK_RECORDS_MAX_RECORD_BYTES,
  TASK_RECORDS_MAX_SESSIONS_PER_BINDING,
  type TaskRecordsState,
  type TaskUsageSettlement
} from './task-records-types'

const TASK_ID = 'task:github:repo-1:issue:31'

function bind(
  state: TaskRecordsState,
  worktreeId = 'repo-1::/repo/feature',
  overrides: Partial<Parameters<typeof upsertTaskRecordBinding>[1]> = {}
) {
  return upsertTaskRecordBinding(state, {
    taskId: TASK_ID,
    hostId: 'local',
    repoId: 'repo-1',
    worktreeId,
    path: `/repo/${worktreeId.split('/').pop()}`,
    isArchived: false,
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    now: 100,
    ...overrides
  })
}

describe('upsertTaskRecordBinding', () => {
  it('creates the record from the first binding', () => {
    const result = bind(EMPTY_TASK_RECORDS)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.changed).toBe(true)
    expect(result.state.byId[TASK_ID]).toMatchObject({
      taskId: TASK_ID,
      bindings: [
        expect.objectContaining({
          worktreeId: 'repo-1::/repo/feature',
          lastVerifiedAt: 100,
          resolvedVia: 'locator'
        })
      ]
    })
    expect(result.state.externalIndex).toEqual({ 'github:repo-1:issue:31': TASK_ID })
  })

  it('adds a second workspace and refreshes the first without a second record', () => {
    const first = bind(EMPTY_TASK_RECORDS)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const second = bind(first.state, 'repo-1::/repo/other')
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    expect(second.state.byId[TASK_ID].bindings.map((binding) => binding.worktreeId)).toEqual([
      'repo-1::/repo/feature',
      'repo-1::/repo/other'
    ])
    expect(Object.keys(second.state.byId)).toEqual([TASK_ID])
  })

  it('reports "no change" for an unchanged refresh so a pin write cannot cause a ledger write', () => {
    const first = bind(EMPTY_TASK_RECORDS)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const again = bind(first.state)
    expect(again).toMatchObject({ ok: true, changed: false })
  })

  it('refuses a second record for one tracker item instead of overwriting', () => {
    const first = bind(EMPTY_TASK_RECORDS)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const conflicting = bind(first.state, 'repo-1::/repo/other', { taskId: 'task:other' })
    expect(conflicting).toEqual({ ok: false, reason: 'external_index_conflict' })
  })

  it('refuses a binding that would make the record exceed its 8 KiB bound', () => {
    // The load path drops a record larger than the bound; accepting the write
    // would report success and lose the task on the next start.
    const result = bind(EMPTY_TASK_RECORDS, 'repo-1::/repo/feature', {
      path: `/repo/${'x'.repeat(TASK_RECORDS_MAX_RECORD_BYTES)}`
    })

    expect(result).toEqual({ ok: false, reason: 'limit' })
  })

  it('applies the same record bound to a session write', () => {
    const first = bind(EMPTY_TASK_RECORDS)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const result = mergeTaskRecordBindingSessions(first.state, {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      sessions: [
        {
          provider: 'claude',
          key: 'session_id',
          id: 'abc',
          transcriptPath: `/t/${'x'.repeat(TASK_RECORDS_MAX_RECORD_BYTES)}`,
          firstSeenAt: 1,
          lastSeenAt: 1
        }
      ],
      now: 2
    })

    expect(result).toEqual({ ok: false, reason: 'limit' })
  })

  it('reports sessions that did not fit the per-binding cap instead of dropping them silently', () => {
    const first = bind(EMPTY_TASK_RECORDS)
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const sessions = Array.from(
      { length: TASK_RECORDS_MAX_SESSIONS_PER_BINDING + 2 },
      (_, index) => ({
        provider: 'claude' as const,
        key: 'session_id',
        id: `s${index}`,
        firstSeenAt: 1,
        lastSeenAt: 1
      })
    )
    const result = mergeTaskRecordBindingSessions(first.state, {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      sessions,
      now: 2
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.dropped).toBe(2)
    expect(result.state.byId[TASK_ID].bindings[0].sessions).toHaveLength(
      TASK_RECORDS_MAX_SESSIONS_PER_BINDING
    )
  })

  it('refuses past the bindings-per-record bound', () => {
    let state = EMPTY_TASK_RECORDS
    for (let index = 0; index < TASK_RECORDS_MAX_BINDINGS_PER_RECORD; index += 1) {
      const result = bind(state, `repo-1::/repo/w${index}`)
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      state = result.state
    }
    expect(bind(state, 'repo-1::/repo/one-too-many')).toEqual({ ok: false, reason: 'limit' })
  })

  it('refuses a write that would push the domain past its byte bound', () => {
    // A domain already at the bound: the next record must be refused, not
    // truncated, so the caller can report it.
    const oversized: TaskRecordsState = {
      recordsVersion: 1,
      byId: {
        'task:github:repo-0:issue:0': {
          taskId: 'task:github:repo-0:issue:0',
          hostId: 'local',
          origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 0 },
          bindings: [
            {
              worktreeId: 'repo-0::/repo/w0',
              repoId: 'repo-0',
              hostId: 'local',
              path: 'x'.repeat(TASK_RECORDS_MAX_DOMAIN_BYTES),
              isArchived: false,
              boundAt: 1,
              boundBy: 'created',
              lastVerifiedAt: 1,
              sessions: []
            }
          ],
          intent: {},
          createdAt: 1,
          updatedAt: 1,
          schemaVersion: 1
        }
      },
      externalIndex: { 'github:repo-0:issue:0': 'task:github:repo-0:issue:0' }
    }

    expect(bind(oversized, 'repo-1::/repo/next', { taskId: 'task:next' })).toEqual({
      ok: false,
      reason: 'limit'
    })
  })

  it('keeps an unresolved binding unresolved until a real verification arrives', () => {
    const first = bind(EMPTY_TASK_RECORDS, 'repo-1::/repo/gone', { verifiedAt: null })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(first.state.byId[TASK_ID].bindings[0]).toMatchObject({ lastVerifiedAt: null })
  })
})

describe('mergeTaskRecordBindingSessions', () => {
  function stateWithBinding(): TaskRecordsState {
    const result = bind(EMPTY_TASK_RECORDS)
    if (!result.ok) {
      throw new Error('fixture binding refused')
    }
    return result.state
  }

  it('stores one entry per provider claim and refreshes the last seen time', () => {
    const state = stateWithBinding()
    const first = mergeTaskRecordBindingSessions(state, {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      sessions: [
        { provider: 'claude', key: 'session_id', id: 'abc', firstSeenAt: 100, lastSeenAt: 100 }
      ],
      now: 100
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(first.state.byId[TASK_ID].bindings[0].sessions).toHaveLength(1)

    const second = mergeTaskRecordBindingSessions(first.state, {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      sessions: [
        {
          provider: 'claude',
          key: 'session_id',
          id: 'abc',
          transcriptPath: '/home/u/abc.jsonl',
          firstSeenAt: 200,
          lastSeenAt: 200
        }
      ],
      now: 200
    })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    expect(second.state.byId[TASK_ID].bindings[0].sessions).toEqual([
      {
        provider: 'claude',
        key: 'session_id',
        id: 'abc',
        transcriptPath: '/home/u/abc.jsonl',
        firstSeenAt: 100,
        lastSeenAt: 200
      }
    ])
  })

  it('keeps a second provider claim as its own entry instead of merging the two', () => {
    const state = stateWithBinding()
    const result = mergeTaskRecordBindingSessions(state, {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      sessions: [
        { provider: 'claude', key: 'session_id', id: 'abc', firstSeenAt: 100, lastSeenAt: 100 },
        { provider: 'codex', key: 'conversation_id', id: 'abc', firstSeenAt: 100, lastSeenAt: 100 }
      ],
      now: 100
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.state.byId[TASK_ID].bindings[0].sessions).toHaveLength(2)
  })
})

describe('setTaskRecordBindingSettlement', () => {
  function stateWithBinding(): TaskRecordsState {
    const result = bind(EMPTY_TASK_RECORDS)
    if (!result.ok) {
      throw new Error('fixture binding refused')
    }
    return result.state
  }

  const known: TaskUsageSettlement = {
    kind: 'known',
    collectedAt: 300,
    scope: 'worktree-rollup',
    worktreeId: 'repo-1::/repo/feature',
    providers: [{ provider: 'claude', tokens: 1_000, costUsd: 0.2 }],
    estimatedCostUsd: 0.2
  }

  it('writes one snapshot and ignores a replay of the same collection', () => {
    const first = setTaskRecordBindingSettlement(stateWithBinding(), {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      settlement: known
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    expect(first.changed).toBe(true)
    expect(first.state.byId[TASK_ID].bindings[0].usageSettlement).toEqual(known)

    const replay = setTaskRecordBindingSettlement(first.state, {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      settlement: known
    })
    expect(replay).toMatchObject({ ok: true, changed: false })
  })

  it('keeps an unavailable snapshot as unavailable, with no figure to print as zero', () => {
    const unavailable: TaskUsageSettlement = {
      kind: 'unavailable',
      collectedAt: 300,
      scope: 'worktree-rollup',
      worktreeId: 'repo-1::/repo/feature',
      reason: 'usage_not_enabled'
    }
    const result = setTaskRecordBindingSettlement(stateWithBinding(), {
      taskId: TASK_ID,
      worktreeId: 'repo-1::/repo/feature',
      hostId: 'local',
      settlement: unavailable
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const settlement = result.state.byId[TASK_ID].bindings[0].usageSettlement
    expect(settlement).toEqual(unavailable)
    expect(settlement).not.toHaveProperty('providers')
  })
})
