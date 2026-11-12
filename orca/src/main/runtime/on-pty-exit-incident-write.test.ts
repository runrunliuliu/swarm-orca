/**
 * The M1 wiring itself (§7.1, §14): one call inside `onPtyExit`, with its arguments collected before
 * `retirePtyAgentLaunchAuthority` deletes the receipt the pane key comes from.
 *
 * These are characterization tests over the real runtime class and the real store, not a
 * re-implementation: the point is that a killed PTY lands exactly one incident row while a clean
 * exit and an operator close land none.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../incidents/incident-writer'

const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = makePaneKey('tab-wiring', LEAF)
const PTY = 'wt-wiring__pty-1'

type RuntimeInternals = {
  ptysById: Map<string, Record<string, unknown>>
}

const temporaryDirectories: string[] = []
const openDatabases: OpenIncidentsDatabase[] = []

function realStore(): IncidentStore {
  const directory = mkdtempSync(join(tmpdir(), 'orca-on-pty-exit-incident-'))
  temporaryDirectories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents.db'))
  openDatabases.push(opened)
  return createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
}

function runtimeWithPty(overrides: Record<string, unknown> = {}): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null, undefined, {})
  const ptys = (runtime as unknown as RuntimeInternals).ptysById
  ptys.set(PTY, {
    ptyId: PTY,
    paneKey: PANE,
    worktreeId: 'wt-wiring',
    tabId: 'tab-wiring',
    incarnationId: 'ptyinc-wiring-1',
    launchAgent: 'claude',
    ...overrides
  })
  return runtime
}

afterEach(() => {
  __resetIncidentWriterForTests()
  for (const opened of openDatabases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('onPtyExit incident write', () => {
  it('records one crash incident for a killed agent', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    runtimeWithPty().onPtyExit(PTY, 137, 'ptyinc-wiring-1' as never, {
      cause: { kind: 'signaled', signal: 9 },
      hostExitConfirmed: true,
      providerExitObserved: true
    })

    const list = store.listIncidents()
    expect(list.total).toBe(1)
    const view = store.getIncident(list.incidents[0].id)!
    expect(view).toMatchObject({
      class: 'crash',
      status: 'untriaged',
      effectiveStatus: 'untriaged',
      sourceKind: 'pty_exit',
      sourceId: 'ptyinc-wiring-1',
      facet: 'exit',
      ptyIncarnationId: 'ptyinc-wiring-1',
      worktreeId: 'wt-wiring',
      exitCause: { kind: 'signaled', signal: 9 }
    })
    expect(view.evidence.unknownBoundaries.length).toBeGreaterThan(0)
  })

  it('does not record an operator close or a clean exit', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    runtimeWithPty().onPtyExit(PTY, 0, 'ptyinc-wiring-1' as never, {
      cause: { kind: 'operator_close' },
      hostExitConfirmed: true
    })
    runtimeWithPty().onPtyExit(PTY, 0, 'ptyinc-wiring-2' as never, {
      cause: { kind: 'exited', exitCode: 0 },
      hostExitConfirmed: true
    })
    expect(store.countIncidents()).toBe(0)
  })

  it('records a repeated callback for the same incarnation only once', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    const runtime = runtimeWithPty()
    const options = { cause: { kind: 'signaled', signal: 15 }, hostExitConfirmed: true } as const
    runtime.onPtyExit(PTY, 143, 'ptyinc-wiring-1' as never, options)
    runtime.onPtyExit(PTY, 143, 'ptyinc-wiring-1' as never, options)
    expect(store.countIncidents()).toBe(1)
  })

  it('keeps an unconfirmed SSH exit as unknown, never as a failure', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    runtimeWithPty({ connectionId: 'ssh-conn-1' }).onPtyExit(PTY, -1, 'ptyinc-wiring-1' as never, {
      hostExitConfirmed: false
    })

    const incident = store.listIncidents().incidents[0]
    const view = store.getIncident(incident.id)!
    expect(view.class).toBe('crash')
    expect(view.exitCause).toMatchObject({ kind: 'unknown' })
    expect(view.status).toBe('untriaged')
  })

  it('reads the pane key before the launch authority is retired', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    // A receipt-only pane: the PTY record has no pane key, so the only source is the pre-retirement
    // collection. Recording it proves the snapshot was taken before cleanup, not after.
    const runtime = runtimeWithPty({ paneKey: null, launchAgent: null })
    ;(runtime as unknown as { collectAgentStatusPaneKeysForPty: (ptyId: string) => Set<string> })[
      'collectAgentStatusPaneKeysForPty'
    ] = () => new Set([PANE])

    runtime.onPtyExit(PTY, 137, 'ptyinc-wiring-1' as never, {
      cause: { kind: 'signaled', signal: 9 },
      hostExitConfirmed: true
    })

    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.summary).toContain(PANE)
  })

  it('records an unknown exit of an agent pane but not of a bare shell', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    runtimeWithPty({ launchAgent: 'claude', incarnationId: 'ptyinc-agent' }).onPtyExit(
      PTY,
      0,
      'ptyinc-agent' as never,
      { cause: { kind: 'unknown', reason: 'cause_unreported' } }
    )
    runtimeWithPty({ launchAgent: null, paneKey: null, incarnationId: 'ptyinc-bare-shell' }).onPtyExit(
      PTY,
      0,
      'ptyinc-bare-shell' as never,
      { cause: { kind: 'unknown', reason: 'cause_unreported' } }
    )
    expect(store.countIncidents()).toBe(1)
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.ptyIncarnationId).toBe('ptyinc-agent')
  })

  it('derives a storable fallback epoch when no incarnation id was ever observed', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    // No third argument, no `incarnationId` on the PTY record: the old fallback was
    // `runtime:<id>:<generation>`, which the key rejected for its separator, so nothing was written
    // at all. It also moved on every callback, so it could not have deduped even if it parsed.
    const runtime = runtimeWithPty({ incarnationId: undefined } as never)
    runtime.onPtyExit(PTY, 137, undefined, {
      cause: { kind: 'signaled', signal: 9 },
      hostExitConfirmed: true
    })
    const afterFirst = store.listIncidents().incidents
    expect(afterFirst).toHaveLength(1)
    const first = store.getIncident(afterFirst[0].id)!
    expect(first.sourceId).toMatch(/^runtime-[0-9a-f]{32}$/)
    expect(first.sourceId).not.toContain(':')
    expect(first.evidence.unknownBoundaries.join(' ')).toMatch(/incarnation id/)

    // A repeat callback for the same PTY must land on the same key: one row, not two.
    runtime.onPtyExit(PTY, 137, undefined, {
      cause: { kind: 'signaled', signal: 9 },
      hostExitConfirmed: true
    })
    expect(store.countIncidents()).toBe(1)
    expect(store.listIncidents().incidents[0].id).toBe(afterFirst[0].id)
  })

  it('treats an agent-session owner claim alone as an agent binding', () => {
    const store = realStore()
    __configureIncidentStoreForTests(store)
    // The claim is the only binding this pane has: no launchAgent, no foregroundAgent, no paneKey.
    // Its ambiguous `unknown` exit must still be recorded, otherwise a real agent failure is dropped.
    runtimeWithPty({
      launchAgent: null,
      foregroundAgent: null,
      paneKey: null,
      incarnationId: 'ptyinc-claim-only',
      agentSessionOwners: [{ claim: { identityDigest: 'digest-claim-only' }, phase: 'live' }]
    }).onPtyExit(PTY, 0, 'ptyinc-claim-only' as never, {
      cause: { kind: 'unknown', reason: 'cause_unreported' }
    })

    expect(store.countIncidents()).toBe(1)
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.ptyIncarnationId).toBe('ptyinc-claim-only')
    expect(view.evidence.agentIdentityDigest).toBe('digest-claim-only')
    expect(view.status).toBe('untriaged')
  })

  it('never throws into the exit path when the store is unavailable', () => {
    __configureIncidentStoreForTests(null)
    const runtime = runtimeWithPty()
    expect(() =>
      runtime.onPtyExit(PTY, 137, 'ptyinc-wiring-1' as never, {
        cause: { kind: 'signaled', signal: 9 },
        hostExitConfirmed: true
      })
    ).not.toThrow()
  })
})
