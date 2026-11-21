import { describe, expect, it } from 'vitest'
import {
  isReadableTaskRecords,
  normalizeTaskRecords,
  recordBytes,
  taskRecordExternalIndexKey,
  taskRecordForTask,
  taskRecordSessionClaimKey,
  taskRecordTaskId,
  taskUsageSettlementTokens
} from './task-records'
import {
  EMPTY_TASK_RECORDS,
  TASK_RECORD_SCHEMA_VERSION,
  TASK_RECORDS_MAX_RECORD_BYTES,
  TASK_RECORDS_VERSION,
  type TaskRecord
} from './task-records-types'

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: taskRecordTaskId({
      provider: 'github',
      repoId: 'repo-1',
      itemType: 'issue',
      number: 31
    }),
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    bindings: [
      {
        worktreeId: 'repo-1::/repo/feature',
        repoId: 'repo-1',
        hostId: 'local',
        path: '/repo/feature',
        isArchived: false,
        boundAt: 1,
        boundBy: 'created',
        lastVerifiedAt: 1,
        resolvedVia: 'locator',
        sessions: []
      }
    ],
    intent: {},
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    ...overrides
  }
}

describe('task record ids', () => {
  it('keys a task by repo, item type and number', () => {
    const issue = taskRecordTaskId({
      provider: 'github',
      repoId: 'repo-1',
      itemType: 'issue',
      number: 31
    })
    const pr = taskRecordTaskId({
      provider: 'github',
      repoId: 'repo-1',
      itemType: 'pr',
      number: 31
    })

    expect(issue).toBe('task:github:repo-1:issue:31')
    // Issue #31 and PR #31 in one repository are two tasks, not one.
    expect(pr).not.toBe(issue)
  })

  it('keeps two providers apart: Linear #31 is a different task from GitHub #31', () => {
    const github = record()
    const linear = record({
      taskId: taskRecordTaskId({
        provider: 'linear',
        repoId: 'repo-1',
        itemType: 'issue',
        number: 31
      }),
      origin: { kind: 'external', provider: 'linear', itemType: 'issue', number: 31 }
    })
    const state = {
      ...EMPTY_TASK_RECORDS,
      byId: { [github.taskId]: github, [linear.taskId]: linear },
      externalIndex: {
        [taskRecordExternalIndexKey({
          provider: 'github',
          repoId: 'repo-1',
          itemType: 'issue',
          number: 31
        })]: github.taskId,
        [taskRecordExternalIndexKey({
          provider: 'linear',
          repoId: 'repo-1',
          itemType: 'issue',
          number: 31
        })]: linear.taskId
      }
    }

    expect(
      taskRecordForTask(state, {
        provider: 'github',
        repoId: 'repo-1',
        itemType: 'issue',
        number: 31
      })
    ).toBe(github)
    // Without a provider the answer is unknown, not "the first one".
    expect(taskRecordForTask(state, { repoId: 'repo-1', itemType: 'issue', number: 31 })).toBeNull()
  })

  it('reads back exactly one task and never a near match', () => {
    const task = record()
    const state = {
      ...EMPTY_TASK_RECORDS,
      byId: { [task.taskId]: task },
      externalIndex: {
        [taskRecordExternalIndexKey({
          provider: 'github',
          repoId: 'repo-1',
          itemType: 'issue',
          number: 31
        })]: task.taskId
      }
    }

    expect(taskRecordForTask(state, { repoId: 'repo-1', itemType: 'issue', number: 31 })).toBe(task)
    expect(taskRecordForTask(state, { repoId: 'repo-1', itemType: 'pr', number: 31 })).toBeNull()
    expect(taskRecordForTask(state, { repoId: 'repo-2', itemType: 'issue', number: 31 })).toBeNull()
    expect(
      taskRecordForTask(undefined, { repoId: 'repo-1', itemType: 'issue', number: 31 })
    ).toBeNull()
  })
})

describe('task records normalization', () => {
  it('keeps a valid record and its index', () => {
    const task = record()
    const { state, dropped, readable } = normalizeTaskRecords({
      recordsVersion: TASK_RECORDS_VERSION,
      byId: { [task.taskId]: task },
      externalIndex: {}
    })

    expect(readable).toBe(true)
    expect(dropped).toBe(0)
    expect(state.byId[task.taskId]).toEqual(task)
    expect(state.externalIndex).toEqual({ 'github:repo-1:issue:31': task.taskId })
  })

  it('drops a malformed record but keeps the others', () => {
    const good = record()
    const { state, dropped } = normalizeTaskRecords({
      recordsVersion: TASK_RECORDS_VERSION,
      byId: {
        [good.taskId]: good,
        broken: { taskId: 'broken', hostId: 'local' },
        'task:repo-1:issue:32': record({
          taskId: 'task:repo-1:issue:32',
          bindings: [
            {
              worktreeId: '',
              repoId: 'repo-1',
              hostId: 'local',
              path: '/p',
              isArchived: false,
              boundAt: 1,
              boundBy: 'created',
              lastVerifiedAt: null,
              sessions: []
            }
          ]
        })
      }
    })

    expect(dropped).toBe(2)
    expect(Object.keys(state.byId)).toEqual([good.taskId])
  })

  it('leaves a domain holding a newer-schema record unreadable instead of rewriting it', () => {
    // Dropping only the newer record and saving the rest would delete history
    // this build cannot read; the whole domain stays verbatim and writers refuse.
    const raw = {
      recordsVersion: TASK_RECORDS_VERSION,
      byId: {
        'task:github:repo-1:issue:31': record({
          schemaVersion: TASK_RECORD_SCHEMA_VERSION + 1
        })
      }
    }
    const result = normalizeTaskRecords(raw)

    expect(result).toMatchObject({ state: EMPTY_TASK_RECORDS, dropped: 0, readable: false })
    expect(isReadableTaskRecords(raw)).toBe(false)
  })

  it('treats a non-finite schema version as a newer record, not a current one', () => {
    // `1e999` in stored JSON parses to Infinity; normalizing it would rewrite
    // the record as this build's schema and lose the newer build's field set.
    const raw = {
      recordsVersion: TASK_RECORDS_VERSION,
      byId: {
        'task:github:repo-1:issue:31': record({ schemaVersion: Infinity })
      }
    }

    expect(normalizeTaskRecords(raw)).toMatchObject({
      state: EMPTY_TASK_RECORDS,
      dropped: 0,
      readable: false
    })
    expect(isReadableTaskRecords(raw)).toBe(false)
  })

  it('keeps the origin provider identity and the domain-level extras on a round-trip', () => {
    const raw = {
      recordsVersion: TASK_RECORDS_VERSION,
      futureDomainField: 7,
      byId: {
        'task:github:repo-1:issue:31': {
          ...record(),
          origin: {
            kind: 'external',
            provider: 'github',
            providerIdentity: { provider: 'github', owner: 'acme', repo: 'web-app' },
            itemType: 'issue',
            number: 31
          }
        }
      },
      externalIndex: { 'github:repo-1:issue:31': 'task:github:repo-1:issue:31' }
    }

    const { state } = normalizeTaskRecords(raw)
    const origin = state.byId['task:github:repo-1:issue:31'].origin

    expect(origin).toMatchObject({
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'web-app' }
    })
    expect(state).toMatchObject({ futureDomainField: 7 })
  })

  it('preserves fields this build does not know, so a round-trip cannot drop them', () => {
    const raw = {
      ...record(),
      futureField: { nested: true }
    }
    const { state } = normalizeTaskRecords({
      recordsVersion: TASK_RECORDS_VERSION,
      byId: { 'task:github:repo-1:issue:31': raw }
    })

    expect(state.byId['task:github:repo-1:issue:31']).toMatchObject({
      futureField: { nested: true }
    })
  })

  it('refuses to interpret a domain with an unknown records version', () => {
    // Fail closed: the load path keeps this payload verbatim and every writer
    // refuses, so a newer build's records cannot be replaced by an empty domain.
    expect(isReadableTaskRecords({ recordsVersion: 2, byId: {}, externalIndex: {} })).toBe(false)
    expect(isReadableTaskRecords({ recordsVersion: 'one', byId: {} })).toBe(false)
    expect(normalizeTaskRecords({ recordsVersion: 2, byId: {} })).toMatchObject({
      readable: false
    })
    expect(isReadableTaskRecords(undefined)).toBe(true)
  })

  it('drops a record that has grown past its size bound', () => {
    const huge = record({ intent: { acceptance: 'x'.repeat(TASK_RECORDS_MAX_RECORD_BYTES) } })
    expect(recordBytes(huge)).toBeGreaterThan(TASK_RECORDS_MAX_RECORD_BYTES)
    expect(
      normalizeTaskRecords({
        recordsVersion: TASK_RECORDS_VERSION,
        byId: { [huge.taskId]: huge }
      }).dropped
    ).toBe(1)
  })
})

describe('settlement totals', () => {
  it('sums the provider rows of a known settlement', () => {
    expect(
      taskUsageSettlementTokens({
        kind: 'known',
        collectedAt: 1,
        scope: 'worktree-rollup',
        worktreeId: 'repo-1::/repo/feature',
        providers: [
          { provider: 'claude', tokens: 900, costUsd: 0.1 },
          { provider: 'muse', tokens: 100, costUsd: null }
        ],
        estimatedCostUsd: null
      })
    ).toBe(1_000)
  })

  it('has no total at all for an unavailable settlement', () => {
    expect(
      taskUsageSettlementTokens({
        kind: 'unavailable',
        collectedAt: 1,
        scope: 'worktree-rollup',
        worktreeId: 'repo-1::/repo/feature',
        reason: 'usage_not_enabled'
      })
    ).toBeNull()
  })
})

describe('session claim keys', () => {
  it('identifies a session by the provider field and id', () => {
    expect(
      taskRecordSessionClaimKey({ key: 'session_id', id: 'abc', firstSeenAt: 1, lastSeenAt: 2 })
    ).toBe('session_id:abc')
  })
})
