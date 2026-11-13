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
  INCIDENT_COUNTS_CHANGED_CHANNEL,
  readIncidentCountsSnapshot,
  readIncidentDetail,
  readIncidentSnapshot,
  registerIncidentHandlers
} from './incidents'
import { __resetIncidentCountsPushForTests } from './incident-counts-push'
import {
  registerIncidentMirrorCoverageReader,
  resetIncidentMirrorCoverageReaderForTests
} from './incident-mirror-coverage'

const handled = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const sent: { channel: string; payload: unknown }[] = []
const windowMock = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handled.set(channel, handler)
    }
  },
  // Why a window mock at all: registering the handlers is what starts the counts push, so the push has
  // to have somewhere to send. The shape asserted below is the real wire shape (`incidents:countsChanged`).
  BrowserWindow: { getAllWindows: () => [windowMock] }
}))

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function realStore(): IncidentStore {
  return realStoreWithDatabase().store
}

function realStoreWithDatabase(): { store: IncidentStore; opened: OpenIncidentsDatabase } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-ipc-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }),
    opened
  }
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
  __resetIncidentCountsPushForTests()
  handled.clear()
  sent.length = 0
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
      // M7-B: the panel's agent column needs the session binding, and a pane-level fact says null
      // rather than inventing an agent name.
      agentSessionId: null,
      decisionCount: 0
    })
  })

  it('attaches the mirror coverage when a reader is registered, and omits it otherwise', () => {
    const { store, opened } = realStoreWithDatabase()
    store.insertIncident(record())
    __configureIncidentStoreForTests(store, opened.db)

    // No reader: "not reported" is absence, never a fabricated "mirrored".
    const withoutMirror = readIncidentSnapshot({ limit: 10 })
    expect(withoutMirror.ok && 'remoteMirror' in withoutMirror.value.coverage).toBe(false)

    registerIncidentMirrorCoverageReader(() => ({ capture: 'not_probed', unsynced: 3 }))
    const withMirror = readIncidentSnapshot({ limit: 10 })
    expect(withMirror.ok && withMirror.value.coverage.remoteMirror).toEqual({
      capture: 'not_probed',
      unsynced: 3
    })

    // A throwing mirror read must not fail the list: it degrades to "not reported".
    registerIncidentMirrorCoverageReader(() => {
      throw new Error('mirror read failed')
    })
    const throwing = readIncidentSnapshot({ limit: 10 })
    expect(throwing.ok).toBe(true)
    expect(throwing.ok && 'remoteMirror' in throwing.value.coverage).toBe(false)
    resetIncidentMirrorCoverageReaderForTests()
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

describe('readIncidentCountsSnapshot', () => {
  it('counts what the badge draws, and answers a closed failure without a store', () => {
    const { store, opened } = realStoreWithDatabase()
    store.insertIncident(record())
    store.insertIncident(record({ id: 'inc_ipc_2', sourceId: 'ptyinc-ipc-2', class: 'tool_error' }))
    store.appendDecision({ incidentId: 'inc_ipc_2', toStatus: 'watch', actor: 'alice', reason: 'r' })
    __configureIncidentStoreForTests(store, opened.db)

    const result = readIncidentCountsSnapshot({ topWorktrees: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value).toMatchObject({ untriaged: 1, total: 2 })
    expect(result.value.byClass.crash).toBe(1)
    expect(result.value.byClass.tool_error).toBe(0)
    expect(result.value.byWorktree).toEqual([{ worktreeId: 'wt-1', untriaged: 1 }])
    expect(result.value.coverage.gap).toBe(false)

    __configureIncidentStoreForTests(null)
    expect(readIncidentCountsSnapshot(undefined)).toMatchObject({
      ok: false,
      code: 'incident_store_unavailable'
    })
  })
})

describe('registerIncidentHandlers', () => {
  it('registers exactly the read/triage/count/grayscale channels', () => {
    registerIncidentHandlers()
    expect([...handled.keys()].sort()).toEqual([
      'incidents:counts',
      'incidents:decide',
      'incidents:detail',
      // Read-only diagnostics. They are registered here so the panel has one surface, and they expose
      // no write path (see incident-gray-views.test.ts).
      'incidents:paneClocks',
      'incidents:snapshot',
      'incidents:toolFailures'
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

  it('pushes the coalesced counts to the window after a write', async () => {
    const { store, opened } = realStoreWithDatabase()
    __configureIncidentStoreForTests(store, opened.db)
    registerIncidentHandlers()

    store.insertIncident(record())
    // Real timers here: the push's windows are short (100ms quiet / 500ms cap) and the assertion is
    // about the channel and payload, not about the exact settle time.
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 2_000 })
    expect(sent[0].channel).toBe(INCIDENT_COUNTS_CHANGED_CHANNEL)
    expect(sent[0].channel).toBe('incidents:countsChanged')
    expect(sent[0].payload).toMatchObject({ untriaged: 1, total: 1 })
  })
})
