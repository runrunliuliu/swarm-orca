/**
 * The writer's contract with `onPtyExit`: it never throws, it reports typed skips, and a repeated
 * callback for one incarnation lands exactly one row (§7.1).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { PtyExitIncidentFacts } from './incident-pty-exit'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests,
  incidentWriterDiagnostics,
  recordPtyExitIncident,
  recordPtyExitIncidentTo
} from './incident-writer'

const temporaryDirectories: string[] = []
const openDatabases: OpenIncidentsDatabase[] = []

function storeFixture(): IncidentStore {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incidents-writer-'))
  temporaryDirectories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents.db'))
  openDatabases.push(opened)
  return createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
}

function facts(overrides: Partial<PtyExitIncidentFacts> = {}): PtyExitIncidentFacts {
  return {
    ptyId: 'wt-1__pty-1',
    incarnationId: 'ptyinc-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agentSessionId: null,
    agentIdentityDigest: null,
    exitCode: 137,
    exitCause: { kind: 'signaled', signal: 9 },
    hostExitConfirmed: true,
    providerExitObserved: true,
    surface: 'local',
    hasAgentBinding: true,
    ...overrides
  }
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

describe('recordPtyExitIncidentTo', () => {
  it('inserts one crash row and reports typed skips for the quiet cases', () => {
    const store = storeFixture()
    expect(recordPtyExitIncidentTo(store, facts(), { hostId: 'host-a', now: 1 }).outcome).toBe(
      'inserted'
    )
    expect(
      recordPtyExitIncidentTo(store, facts({ exitCause: { kind: 'operator_close' } })).outcome
    ).toBe('skipped')
    expect(
      recordPtyExitIncidentTo(store, facts({ exitCause: { kind: 'exited', exitCode: 0 } })).outcome
    ).toBe('skipped')
    expect(store.countIncidents()).toBe(1)
  })

  it('is idempotent for a repeated callback on the same incarnation', () => {
    const store = storeFixture()
    const first = recordPtyExitIncidentTo(store, facts(), { hostId: 'h', now: 1 })
    const second = recordPtyExitIncidentTo(store, facts(), { hostId: 'h', now: 2 })
    expect(first.outcome).toBe('inserted')
    expect(second.outcome).toBe('duplicate')
    expect(second.id).toBe(first.id)
    expect(store.countIncidents()).toBe(1)
  })

  it('survives an unavailable store without throwing', () => {
    const result = recordPtyExitIncidentTo(null, facts())
    expect(result).toEqual({ outcome: 'skipped', reason: 'incident_store_unavailable' })
  })

  it('reports a capacity stop instead of pretending the row was written', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-incidents-writer-cap-'))
    temporaryDirectories.push(directory)
    const opened = openIncidentsDatabase(join(directory, 'incidents.db'))
    openDatabases.push(opened)
    const store = createIncidentStore({ db: opened.db, limits: { maxRows: 1 } })
    recordPtyExitIncidentTo(store, facts({ exitCause: { kind: 'exited', exitCode: 3 } }))
    const next = recordPtyExitIncidentTo(store, facts({ incarnationId: 'ptyinc-2' }))
    // Crash rows are exempt from the limit, so this one still lands; the exemption is what keeps a
    // failure visible when the store is full of noise.
    expect(next.outcome).toBe('inserted')
    expect(store.countIncidents()).toBe(2)
    expect(store.coverage().currentlyLimited).toBe(true)
  })
})

describe('recordPtyExitIncident', () => {
  it('records through the process-wide store and never throws', () => {
    const store = storeFixture()
    __configureIncidentStoreForTests(store)
    expect(() => recordPtyExitIncident(facts())).not.toThrow()
    expect(store.countIncidents()).toBe(1)
    expect(incidentWriterDiagnostics()).toMatchObject({ attempts: 1, inserted: 1 })
  })

  it('turns an unavailable store into a diagnostics counter, not an exception', () => {
    __configureIncidentStoreForTests(null)
    expect(() => recordPtyExitIncident(facts())).not.toThrow()
    expect(incidentWriterDiagnostics()).toMatchObject({
      skipped: 1,
      lastSkipReason: 'incident_store_unavailable'
    })
  })

  it('never lets an unexpected store failure escape into the PTY teardown', () => {
    const exploding = {
      ...storeFixture(),
      insertIncident: () => {
        throw new Error('disk gone')
      }
    } as IncidentStore
    __configureIncidentStoreForTests(exploding)
    expect(() => recordPtyExitIncident(facts())).not.toThrow()
    expect(incidentWriterDiagnostics().failures).toBe(1)
  })
})
