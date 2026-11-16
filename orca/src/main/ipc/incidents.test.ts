/**
 * IPC read model (§12, M2): the same facts the CLI prints, delivered as a closed result instead of
 * a thrown crossing the bridge. The shapes are pinned here so a future renderer cannot invent a
 * second interpretation of `currently_limited` or of the entry-vs-effective status.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncidentRecord } from '../incidents/incident-types'
import { closeStorePairs, openStorePair, record } from '../incidents/incident-test-fixture'
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
import type { MirrorCoverage } from '../incidents/incident-mirror-types'

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

/**
 * The one thing a real store cannot demonstrate here is a *failing* mirror read, and the rule under
 * test is that it costs only the optional `remoteMirror` field. So the read is replaced at the seam
 * `incident-mirror-coverage.ts` imports: the DTO projection and its single try/catch boundary stay the
 * production code, and only the answer is injected. (This used to be a process-global registration with
 * a test reset; that seam is gone, and a module mock is the local equivalent.)
 */
const mirrorRead = vi.hoisted(() => ({
  /** Test-set answer: return a coverage value, or throw to exercise the failure boundary. */
  answer: null as null | (() => unknown)
}))

vi.mock('../incidents/incident-mirror-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../incidents/incident-mirror-store')>()
  return {
    ...actual,
    readIncidentMirrorCoverage: () => {
      if (mirrorRead.answer === null) {
        throw new Error('mirror store unavailable')
      }
      return mirrorRead.answer()
    }
  }
})

/** A `MirrorCoverage` with the DTO's three inputs stated and every other fact at its zero value. */
function mirrorCoverage(overrides: Partial<MirrorCoverage> = {}): MirrorCoverage {
  return {
    capture: 'unsupported',
    hosts: [],
    unsynced: null,
    unsyncedAsOf: null,
    unreachable: 0,
    rejected: 0,
    pruned: 0,
    lastError: null,
    mirroredRowsPresent: 0,
    skippedRows: 0,
    provenanceConflicts: 0,
    ...overrides
  }
}

/** The local facts with the optional remote hint removed: what a failing read must not change. */
function localCoverage<T extends object>(coverage: T): Omit<T, 'remoteMirror'> {
  const { remoteMirror: _omitted, ...local } = coverage as T & { remoteMirror?: unknown }
  return local
}

// Every row in this file is one pty-exit crash; the shared fixture owns the boring defaults
// (fingerprint, empty evidence, host-a/wt-1), so only what makes it a pty exit is stated here.
const PTY_EXIT: Partial<IncidentRecord> = {
  id: 'inc_ipc_1',
  sourceKind: 'pty_exit',
  sourceId: 'ptyinc-ipc-1',
  facet: 'exit',
  runId: null,
  ptyIncarnationId: 'ptyinc-ipc-1',
  class: 'crash',
  exitCause: { kind: 'unknown', reason: 'stop_unverified' },
  evidence: { pointers: [], unknownBoundaries: ['stop never confirmed'] },
  summary: 'stop never confirmed'
}

function sharedStore(): ReturnType<typeof openStorePair>['store'] {
  return openStorePair().store
}

afterEach(() => {
  vi.restoreAllMocks()
  mirrorRead.answer = null
  __resetIncidentWriterForTests()
  __resetIncidentCountsPushForTests()
  handled.clear()
  sent.length = 0
  closeStorePairs()
})

describe('readIncidentSnapshot', () => {
  it('returns the list plus both capacity facts and the remote gap', () => {
    const store = sharedStore()
    store.insertIncident(record({ ...PTY_EXIT }))
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

  it('attaches the mirror hint through one adapter, and a failed read costs only that hint', () => {
    const { store, opened } = openStorePair()
    store.insertIncident(record({ ...PTY_EXIT }))
    __configureIncidentStoreForTests(store, opened.db)

    // A throwing read is "not reported", never a failed list: the key is absent, the local facts stay.
    const failed = readIncidentSnapshot({ limit: 10 })
    expect(failed.ok).toBe(true)
    if (!failed.ok) {
      return
    }
    expect('remoteMirror' in failed.value.coverage).toBe(false)

    mirrorRead.answer = () => mirrorCoverage({ capture: 'not_probed', unsynced: 3 })
    const attached = readIncidentSnapshot({ limit: 10 })
    expect(attached.ok).toBe(true)
    if (!attached.ok) {
      return
    }
    expect(attached.value.coverage.remoteMirror).toEqual({
      capture: 'not_probed',
      unsynced: 3,
      monitored: true
    })
    // The adapter adds the hint and moves nothing else — the local verdict is bit-for-bit the same.
    expect(localCoverage(attached.value.coverage)).toEqual(localCoverage(failed.value.coverage))
    expect(attached.value.total).toBe(failed.value.total)
    expect(attached.value.incidents).toEqual(failed.value.incidents)
  })

  it('degrades the counts read and the coalesced push the same way when the mirror read fails', async () => {
    const { store, opened } = openStorePair()
    __configureIncidentStoreForTests(store, opened.db)
    registerIncidentHandlers()

    mirrorRead.answer = () => {
      throw new Error('mirror store unavailable')
    }
    store.insertIncident(record({ ...PTY_EXIT }))

    const counts = readIncidentCountsSnapshot(undefined)
    expect(counts.ok).toBe(true)
    expect(counts.ok && 'remoteMirror' in counts.value.coverage).toBe(false)
    // The push reads the same fields; it must land with the badge's number and no remote claim.
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 2_000 })
    const pushed = sent[0].payload as { untriaged: number; coverage: Record<string, unknown> }
    expect(pushed.untriaged).toBe(1)
    expect('remoteMirror' in pushed.coverage).toBe(false)
  })

  it('rejects an unknown filter and an unavailable store with a closed result', () => {
    const store = sharedStore()
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
    const store = sharedStore()
    store.insertIncident(record({ ...PTY_EXIT }))
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
    __configureIncidentStoreForTests(sharedStore())
    expect(readIncidentDetail({ incidentId: 'nope' })).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('decideIncident', () => {
  it('appends a decision and reports the transition', () => {
    const store = sharedStore()
    store.insertIncident(record({ ...PTY_EXIT }))
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
    const store = sharedStore()
    store.insertIncident(record({ ...PTY_EXIT }))
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
    const { store, opened } = openStorePair()
    store.insertIncident(record({ ...PTY_EXIT }))
    store.insertIncident(
      record({ ...PTY_EXIT, id: 'inc_ipc_2', sourceId: 'ptyinc-ipc-2', class: 'tool_error' })
    )
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
    const store = sharedStore()
    store.insertIncident(record({ ...PTY_EXIT }))
    __configureIncidentStoreForTests(store)
    const snapshot = handled.get('incidents:snapshot')?.({}, undefined) as {
      ok: boolean
      value: { total: number }
    }
    expect(snapshot.ok).toBe(true)
    expect(snapshot.value.total).toBe(1)
  })

  it('pushes the coalesced counts to the window after a write', async () => {
    const { store, opened } = openStorePair()
    __configureIncidentStoreForTests(store, opened.db)
    registerIncidentHandlers()

    store.insertIncident(record({ ...PTY_EXIT }))
    // Real timers here: the push's windows are short (100ms quiet / 500ms cap) and the assertion is
    // about the channel and payload, not about the exact settle time.
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 2_000 })
    expect(sent[0].channel).toBe(INCIDENT_COUNTS_CHANGED_CHANNEL)
    expect(sent[0].channel).toBe('incidents:countsChanged')
    expect(sent[0].payload).toMatchObject({ untriaged: 1, total: 1 })
  })
})
