import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { TASK_RECORD_METHODS } from './task-records'
import type { TaskRecord } from '../../../../shared/task-records-types'

/**
 * The runtime half of the cross-profile read (issue #31).
 *
 * What this file owns: the wire contract (one identity in, one record out), the
 * two properties the feature would be dangerous without — **read-only** (no write
 * method of the store is reachable from the handler) and **scoped** (a repo this
 * runtime does not hold answers `repoKnown: false` instead of an empty record) —
 * and the fact that an unknown/absent repo is a scope answer rather than a
 * fabricated "no history".
 */

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

/** A syntactically valid record; only the fields the read path carries matter
 *  here, and every value is synthetic (no real ids, paths or sessions). */
function makeRecord(): TaskRecord {
  return {
    taskId: 'task:github:repo-1:issue:7',
    hostId: 'runtime:env-a',
    origin: {
      kind: 'external',
      provider: 'github',
      itemType: 'issue',
      number: 7
    },
    bindings: [
      {
        worktreeId: 'repo-1::/srv/checkout',
        repoId: 'repo-1',
        hostId: 'runtime:env-a',
        path: '/srv/checkout',
        isArchived: true,
        boundAt: 1,
        boundBy: 'created',
        lastVerifiedAt: 2,
        sessions: [],
        runs: [],
        gaps: []
      }
    ],
    intent: { archived: true },
    createdAt: 1,
    updatedAt: 2,
    schemaVersion: 3
  }
}

function makeRuntime(result: { record: TaskRecord | null; repoKnown: boolean }) {
  const getTaskRecordForTask = vi.fn().mockReturnValue(result)
  return {
    runtime: {
      getRuntimeId: () => 'test-runtime',
      getTaskRecordForTask
    } as unknown as OrcaRuntimeService,
    getTaskRecordForTask
  }
}

class ReceiverSensitiveStore {
  readonly state: { record: TaskRecord | null }

  constructor(record: TaskRecord | null) {
    this.state = { record }
  }

  getRepo(repoId: string): { id: string } | null {
    return repoId === 'repo-1' ? { id: repoId } : null
  }

  getTaskRecordForTask(): TaskRecord | null {
    return this.state.record
  }
}

describe('taskRecords.get', () => {
  it('keeps the Store receiver while reading a known repository', async () => {
    const record = makeRecord()
    const store = new ReceiverSensitiveStore(record)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture exposes only the two runtime methods the dispatcher reaches.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getTaskRecordForTask: (params: unknown) =>
        Reflect.apply(OrcaRuntimeService.prototype.getTaskRecordForTask, { store }, [params])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TASK_RECORD_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('taskRecords.get', {
        repoId: 'repo-1',
        itemType: 'issue',
        number: 7,
        provider: 'github'
      })
    )

    expect(response).toMatchObject({ ok: true, result: { record, repoKnown: true } })
  })

  it('answers null without throwing when the store has no task-record accessor', () => {
    // The accessor is optional in the store contract (runtime-store-contract.ts):
    // the headless root and test doubles build the store by parts. A store with
    // `getRepo` but no `getTaskRecordForTask` must answer "could not ask", not throw.
    const store = { getRepo: (repoId: string) => (repoId === 'repo-1' ? { id: repoId } : null) }

    const result = Reflect.apply(
      OrcaRuntimeService.prototype.getTaskRecordForTask,
      { store },
      [{ repoId: 'repo-1', itemType: 'issue', number: 7, provider: 'github' }]
    )

    expect(result).toEqual({ record: null, repoKnown: true })
  })

  it('answers one identity with the record this runtime holds', async () => {
    const record = makeRecord()
    const { runtime, getTaskRecordForTask } = makeRuntime({ record, repoKnown: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: TASK_RECORD_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('taskRecords.get', {
        repoId: 'repo-1',
        itemType: 'issue',
        number: 7,
        provider: 'github'
      })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { record, repoKnown: true }
    })
    expect(getTaskRecordForTask).toHaveBeenCalledWith({
      repoId: 'repo-1',
      itemType: 'issue',
      number: 7,
      provider: 'github'
    })
  })

  it('keeps the provider optional, so an ambiguous page is answered by the store rule', async () => {
    const { runtime, getTaskRecordForTask } = makeRuntime({ record: null, repoKnown: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: TASK_RECORD_METHODS })

    await dispatcher.dispatch(
      makeRequest('taskRecords.get', { repoId: 'repo-1', itemType: 'pr', number: 9 })
    )

    expect(getTaskRecordForTask).toHaveBeenCalledWith({
      repoId: 'repo-1',
      itemType: 'pr',
      number: 9
    })
  })

  it('rejects a malformed identity at the wire instead of reading some other task', async () => {
    const { runtime, getTaskRecordForTask } = makeRuntime({ record: null, repoKnown: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: TASK_RECORD_METHODS })

    for (const params of [
      null,
      {},
      { repoId: '', itemType: 'issue', number: 7 },
      { repoId: 'repo-1', itemType: 'discussion', number: 7 },
      { repoId: 'repo-1', itemType: 'issue', number: 1.5 },
      { repoId: 'repo-1', itemType: 'issue', number: 7, provider: 'bitbucket' }
    ]) {
      const response = await dispatcher.dispatch(makeRequest('taskRecords.get', params))
      expect(response.ok).toBe(false)
    }
    expect(getTaskRecordForTask).not.toHaveBeenCalled()
  })

  it('answers repoKnown: false when this runtime has no such repo registration', async () => {
    // The scope rule, made observable: an environment asked about another
    // environment's repo says so, and the caller keeps its own content.
    const { runtime } = makeRuntime({ record: null, repoKnown: false })
    const dispatcher = new RpcDispatcher({ runtime, methods: TASK_RECORD_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('taskRecords.get', { repoId: 'other-host-repo', itemType: 'issue', number: 7 })
    )

    expect(response).toMatchObject({ ok: true, result: { record: null, repoKnown: false } })
  })

  it('can answer a colliding but wrong repo id as known and empty', async () => {
    // This is why the renderer must resolve the answering runtime's own repo id first:
    // a host-local id collision is indistinguishable from an honestly empty task here.
    const { runtime, getTaskRecordForTask } = makeRuntime({ record: null, repoKnown: true })
    const dispatcher = new RpcDispatcher({ runtime, methods: TASK_RECORD_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('taskRecords.get', {
        repoId: 'local-id-that-collides-remotely',
        itemType: 'issue',
        number: 7
      })
    )

    expect(response).toMatchObject({ ok: true, result: { record: null, repoKnown: true } })
    expect(getTaskRecordForTask).toHaveBeenCalledWith({
      repoId: 'local-id-that-collides-remotely',
      itemType: 'issue',
      number: 7
    })
  })
})
