/**
 * IPC read model (§12, M2): the same facts the CLI prints, delivered as a closed result instead of
 * a thrown crossing the bridge. The shapes are pinned here so a future renderer cannot invent a
 * second interpretation of `currently_limited` or of the entry-vs-effective status.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncidentRecord } from '../incidents/incident-types'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../incidents/incident-writer'
import {
  decideIncident,
  readIncidentDetail,
  readIncidentSnapshot,
  registerIncidentHandlers
} from './incidents'

const handled = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handled.set(channel, handler)
    }
  }
}))

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function realStore(): IncidentStore {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-ipc-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: 'inc_ipc_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-ipc-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-ipc-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'unknown', reason: 'stop_unverified' },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: ['stop never confirmed'] },
    summary: 'stop never confirmed',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  __resetIncidentWriterForTests()
  handled.clear()
  for (const opened of databases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('readIncidentSnapshot', () => {
  it('returns the list plus both capacity facts and the remote gap', () => {
    const store = realStore()
    store.insertIncident(record())
    __configureIncidentStoreForTests(store)

    const result = readIncidentSnapshot({ limit: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.total).toBe(1)
    expect(result.value.coverage).toMatchObject({
      remoteIncidentCapture: 'unsupported',
      capacityLatchSet: false,
      currentlyLimited: false
    })
    expect(result.value.incidents[0]).toMatchObject({
      id: 'inc_ipc_1',
      class: 'crash',
      status: 'untriaged',
      effectiveStatus: 'untriaged',
      worktreeId: 'wt-1',
      decisionCount: 0
    })
  })

  it('rejects an unknown filter and an unavailable store with a closed result', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    expect(readIncidentSnapshot({ status: 'nope' as never })).toMatchObject({ ok: false })

    __configureIncidentStoreForTests(null)
    expect(readIncidentSnapshot({})).toMatchObject({
      ok: false,
      code: 'incident_store_unavailable'
    })
  })
})

describe('readIncidentDetail', () => {
  it('carries unknowns, evidence pointers and the projected status', () => {
    const store = realStore()
    store.insertIncident(record())
    store.appendDecision({ incidentId: 'inc_ipc_1', toStatus: 'watch', actor: 'alice', reason: 'r' })
    __configureIncidentStoreForTests(store)

    const result = readIncidentDetail({ incidentId: 'inc_ipc_1' })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value).toMatchObject({ status: 'untriaged', effectiveStatus: 'watch' })
    expect(result.value.evidence.unknownBoundaries).toEqual(['stop never confirmed'])
    expect(result.value.decisions).toHaveLength(1)
    expect(result.value.decisions[0]).toMatchObject({ actor: 'alice', toStatus: 'watch' })
  })

  it('reports a missing incident as not_found', () => {
    __configureIncidentStoreForTests(realStore())
    expect(readIncidentDetail({ incidentId: 'nope' })).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('decideIncident', () => {
  it('appends a decision and reports the transition', () => {
    const store = realStore()
    store.insertIncident(record())
    __configureIncidentStoreForTests(store)

    const result = decideIncident({
      incidentId: 'inc_ipc_1',
      toStatus: 'watch',
      reason: 'wait for a second occurrence'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value).toMatchObject({
      outcome: 'appended',
      fromStatus: 'untriaged',
      toStatus: 'watch',
      actor: 'unspecified'
    })
    // The projected status moved; the row did not.
    expect(store.getIncident('inc_ipc_1')?.effectiveStatus).toBe('watch')
    expect(store.getIncident('inc_ipc_1')?.status).toBe('untriaged')
  })

  it('mirrors the CLI rules: no invented actor, terminal states stay final', () => {
    const store = realStore()
    store.insertIncident(record())
    __configureIncidentStoreForTests(store)

    expect(
      decideIncident({ incidentId: 'inc_ipc_1', toStatus: 'invalid', reason: 'not a bug' })
    ).toMatchObject({ ok: true, value: { outcome: 'appended' } })
    expect(
      decideIncident({ incidentId: 'inc_ipc_1', toStatus: 'confirmed', reason: 'x' })
    ).toMatchObject({ ok: true, value: { outcome: 'actor_required' } })
    expect(
      decideIncident({ incidentId: 'inc_ipc_1', toStatus: 'confirmed', actor: 'alice', reason: 'x' })
    ).toMatchObject({ ok: true, value: { outcome: 'invalid_transition' } })
    expect(
      decideIncident({ incidentId: 'inc_ipc_1', toStatus: 'watch', reason: 'r' })
    ).toMatchObject({ ok: true, value: { outcome: 'invalid_transition' } })
  })
})

describe('registerIncidentHandlers', () => {
  it('registers exactly the three read/triage channels', () => {
    registerIncidentHandlers()
    expect([...handled.keys()].sort()).toEqual([
      'incidents:decide',
      'incidents:detail',
      'incidents:snapshot'
    ])
    const store = realStore()
    store.insertIncident(record())
    __configureIncidentStoreForTests(store)
    const snapshot = handled.get('incidents:snapshot')?.({}, undefined) as {
      ok: boolean
      value: { total: number }
    }
    expect(snapshot.ok).toBe(true)
    expect(snapshot.value.total).toBe(1)
  })
})
