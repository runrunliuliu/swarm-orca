/**
 * The three incident read methods over the real dispatcher (A-fix, 2026-11-16).
 *
 * Why a dispatcher test and not only a handler test: the panel reaches a paired host through this
 * registry, so "the method exists, its params are validated, and an unknown method is reported as
 * `method_not_found`" is the wire contract a client depends on. The store itself is the read service's
 * test seam, which is already pinned separately against real SQLite fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { openIncidentsDatabase } from '../../../incidents/incidents-database'
import { createIncidentStore } from '../../../incidents/incident-store'
import {
  __configureIncidentReadStoreForTests,
  __resetIncidentReadStoreForTests
} from '../../../incidents/incident-read-service'
import { INCIDENT_METHODS } from './incidents'

const directories: string[] = []
let closeTestStore: (() => void) | null = null

function runtime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-under-test'
  } as unknown as OrcaRuntimeService
}

function request(method: string, params: unknown = {}): RpcRequest {
  return { id: `req-${method}`, authToken: 'tok', method, params }
}

function dispatcher(): RpcDispatcher {
  return new RpcDispatcher({ runtime: runtime(), methods: INCIDENT_METHODS })
}

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incidents-rpc-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents.db'))
  const store = createIncidentStore({ db: opened.db })
  store.insertIncident({
    id: 'inc_rpc_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-rpc-1',
    facet: 'exit',
    hostId: 'host-rpc',
    worktreeId: 'wt-rpc',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-rpc-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'c'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: ['transcript pointer not collected'] },
    summary: 'Agent process killed by signal 9',
    createdAt: 1_700_000_000_000
  })
  closeTestStore = () => opened.db.close()
  __configureIncidentReadStoreForTests({
    availability: 'supported',
    db: opened.db,
    store,
    close: () => undefined
  })
})

afterEach(() => {
  closeTestStore?.()
  closeTestStore = null
  __resetIncidentReadStoreForTests()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('incidents.* over the dispatcher', () => {
  it('serves the snapshot with the host marking it local', async () => {
    const response = await dispatcher().dispatch(request('incidents.snapshot', {}))

    expect(response).toMatchObject({ ok: true })
    if (!response.ok) {
      throw new Error('expected success')
    }
    expect(response.result).toMatchObject({
      source: { kind: 'local' },
      availability: 'supported',
      total: 1
    })
  })

  it('serves one detail and refuses a missing id as not_found', async () => {
    const found = await dispatcher().dispatch(
      request('incidents.detail', { incidentId: 'inc_rpc_1' })
    )
    expect(found).toMatchObject({ ok: true })
    if (found.ok) {
      expect(found.result).toMatchObject({ id: 'inc_rpc_1', source: { kind: 'local' } })
    }

    const missing = await dispatcher().dispatch(
      request('incidents.detail', { incidentId: 'inc_missing' })
    )
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('serves counts that the badge can draw, with the same source vocabulary', async () => {
    const response = await dispatcher().dispatch(request('incidents.counts', { topWorktrees: 1 }))

    expect(response).toMatchObject({ ok: true })
    if (!response.ok) {
      throw new Error('expected success')
    }
    expect(response.result).toMatchObject({
      untriaged: 1,
      total: 1,
      source: { kind: 'local' },
      availability: 'supported'
    })
  })

  it('rejects params it cannot honour instead of guessing', async () => {
    const badStatus = await dispatcher().dispatch(
      request('incidents.snapshot', { status: 'not_a_status' })
    )
    expect(badStatus).toMatchObject({ ok: false })

    const badLimit = await dispatcher().dispatch(request('incidents.snapshot', { limit: -1 }))
    expect(badLimit).toMatchObject({ ok: false })
  })

  it('reports an unregistered method as method_not_found, which is how a client says "unsupported"', async () => {
    const response = await new RpcDispatcher({ runtime: runtime(), methods: [] }).dispatch(
      request('incidents.snapshot', {})
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
  })

  it('exposes no mutation methods', () => {
    const names = INCIDENT_METHODS.map((method) => method.name)
    expect(names).toEqual(['incidents.snapshot', 'incidents.detail', 'incidents.counts'])
    expect(names.some((name) => /decide|prune|archive|retry/.test(name))).toBe(false)
  })

  it('keeps the read path free of writes', async () => {
    const dispatcherUnderTest = dispatcher()
    await dispatcherUnderTest.dispatch(request('incidents.snapshot', {}))
    await dispatcherUnderTest.dispatch(request('incidents.counts', {}))
    // The seam exposes the same store the handlers read; nothing above may have appended a decision.
    const again = await dispatcherUnderTest.dispatch(
      request('incidents.detail', { incidentId: 'inc_rpc_1' })
    )
    expect(again).toMatchObject({ ok: true })
    if (again.ok) {
      expect((again.result as { decisionCount: number }).decisionCount).toBe(0)
    }
  })
})

// Why the mock reset is explicit: the dispatcher builds its registry once per instance, and a leaked
// `vi` mock would hide a method that stopped being registered.
afterEach(() => {
  vi.restoreAllMocks()
})
