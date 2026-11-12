/**
 * M3's two behavioural promises, on a real database with a fake clock:
 *   * default mode writes nothing, and only reports what it would have written (grayscale);
 *   * the switch on writes exactly at the boundary, once per epoch, and never for a declared,
 *     unknown, or recovered pane.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import { STALL_THRESHOLD_MS } from './incident-stall-decision'
import { declareWait, listActiveWaits } from './incident-wait'
import {
  __resetStallSamplerForTests,
  readStallSampleCoverage,
  stallRowsFromStatusSnapshot,
  sampleStallState,
  startStallSampler,
  stopStallSampler,
  stallSamplerRunning,
  type StallSampleSourceRow
} from './incidents-stall-sampler'
import { readStallSamples } from './incident-stall-samples'

const NOW = 1_700_000_000_000
const EPOCH = NOW - STALL_THRESHOLD_MS

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function fixture(): {
  db: OpenIncidentsDatabase['db']
  store: IncidentStore
  userDataPath: string
} {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-stall-sampler-'))
  directories.push(userDataPath)
  const opened = openIncidentsDatabase(join(userDataPath, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    db: opened.db,
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }),
    userDataPath
  }
}

function row(overrides: Partial<StallSampleSourceRow> = {}): StallSampleSourceRow {
  return {
    paneKey: 'tab-1:leaf-1',
    terminalHandle: 'term-1',
    state: 'working',
    stateStartedAt: EPOCH,
    turnStartedAt: null,
    observedAt: NOW - 30_000,
    ...overrides
  }
}

afterEach(() => {
  __resetStallSamplerForTests()
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

describe('grayscale: default off', () => {
  it('reports the verdict but writes no incident', () => {
    const { db, store, userDataPath } = fixture()
    const first = sampleStallState({
      db,
      store,
      now: NOW,
      rows: [row()],
      writeEnabled: false,
      userDataPath
    })
    expect(first).toMatchObject({ panes: 1, wouldStall: 0, stalled: 0 })
    // Cycle 1 is never enough, even at 45 minutes.
    expect(first.rows[0]).toMatchObject({ wouldStall: false, reason: 'insufficient_cycles' })
    const second = sampleStallState({
      db,
      store,
      now: NOW,
      rows: [row()],
      writeEnabled: false,
      userDataPath
    })
    expect(second.rows[0]).toMatchObject({ wouldStall: true, reason: 'stalled' })
    expect(store.countIncidents()).toBe(0)
    expect(readStallSampleCoverage(db)).toMatchObject({
      panes: 1,
      wouldStall: 1,
      stalled: 1,
      writeEnabled: false,
      writes: 0
    })
  })

  it('persists the sample for the stalls command, including the declaration text', () => {
    const { db, store, userDataPath } = fixture()
    declareWait(db, { paneKey: 'tab-1:leaf-1', epoch: String(EPOCH), reason: 'long build', actor: 'alice', expiresAt: null, now: NOW - 1000 })
    sampleStallState({ db, store, now: NOW, rows: [row()], writeEnabled: false, userDataPath })
    const samples = readStallSamples(db)
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      terminalHandle: 'term-1',
      state: 'working',
      reason: 'waiting_declared',
      declaredWait: 'long build',
      wouldStall: false
    })
    expect(readStallSampleCoverage(db).declaredWaits).toBe(1)
  })

  it('drops panes that disappeared from the next sample', () => {
    const { db, store, userDataPath } = fixture()
    sampleStallState({ db, store, now: NOW, rows: [row()], writeEnabled: false, userDataPath })
    sampleStallState({ db, store, now: NOW + 60_000, rows: [], writeEnabled: false, userDataPath })
    expect(readStallSamples(db)).toHaveLength(0)
  })
})

describe('write path: switch on', () => {
  it('writes exactly one no_progress incident, and never at 44:59', () => {
    const { db, store, userDataPath } = fixture()
    // One minute before the threshold: two cycles, still below.
    sampleStallState({
      db,
      store,
      now: EPOCH + STALL_THRESHOLD_MS - 1,
      rows: [row()],
      writeEnabled: true,
      userDataPath
    })
    sampleStallState({
      db,
      store,
      now: EPOCH + STALL_THRESHOLD_MS - 1,
      rows: [row()],
      writeEnabled: true,
      userDataPath
    })
    expect(store.countIncidents()).toBe(0)

    // At exactly 45 minutes, with the second cycle behind it: one row.
    sampleStallState({ db, store, now: NOW, rows: [row()], writeEnabled: true, userDataPath })
    expect(store.countIncidents()).toBe(1)
    const incident = store.listIncidents().incidents[0]
    const view = store.getIncident(incident.id)!
    expect(view).toMatchObject({
      class: 'no_progress',
      sourceKind: 'status_stall',
      sourceId: `tab-1:leaf-1:${EPOCH}`,
      facet: 'stall',
      status: 'untriaged'
    })
    expect(view.summary).toContain('No progress')

    // The same epoch on the next tick is a duplicate, not a second row.
    sampleStallState({ db, store, now: NOW + 60_000, rows: [row()], writeEnabled: true, userDataPath })
    expect(store.countIncidents()).toBe(1)
    expect(readStallSampleCoverage(db).writes).toBe(1)
  })

  it('writes a second row only after the pane recovers to a new epoch', () => {
    const { db, store, userDataPath } = fixture()
    sampleStallState({ db, store, now: NOW, rows: [row()], writeEnabled: true, userDataPath })
    sampleStallState({ db, store, now: NOW + 1_000, rows: [row()], writeEnabled: true, userDataPath })
    expect(store.countIncidents()).toBe(1)

    // Recovery: a new stateStartedAt means a fresh epoch and a fresh two-cycle count.
    const recoveredAt = NOW + 2_000
    sampleStallState({
      db,
      store,
      now: recoveredAt,
      rows: [row({ stateStartedAt: recoveredAt })],
      writeEnabled: true,
      userDataPath
    })
    sampleStallState({
      db,
      store,
      now: recoveredAt + STALL_THRESHOLD_MS,
      rows: [row({ stateStartedAt: recoveredAt })],
      writeEnabled: true,
      userDataPath
    })
    expect(store.countIncidents()).toBe(2)
    expect(store.listIncidents().incidents.map((entry) => entry.id)).toHaveLength(2)
  })

  it('never writes for a declared wait, an unknown state, or a healthy pane', () => {
    const { db, store, userDataPath } = fixture()
    declareWait(db, { paneKey: 'tab-1:leaf-1', epoch: String(EPOCH), reason: 'training', actor: 'a', expiresAt: null, now: NOW - 1000 })
    // Two cycles with the declaration live.
    sampleStallState({ db, store, now: NOW, rows: [row()], writeEnabled: true, userDataPath })
    sampleStallState({ db, store, now: NOW + 60_000, rows: [row()], writeEnabled: true, userDataPath })
    expect(store.countIncidents()).toBe(0)

    // Declared pane recovers; the declaration no longer applies, but instead we drop to unknown.
    sampleStallState({
      db,
      store,
      now: NOW + 2 * 60_000,
      rows: [row({ state: 'unknown' })],
      writeEnabled: true,
      userDataPath
    })
    expect(store.countIncidents()).toBe(0)
    expect(listActiveWaits(db, { now: NOW })).toHaveLength(1)
  })
})

describe('source adapter', () => {
  it('drops resume-identity-only rows and prefers the evidence clock', () => {
    const rows = stallRowsFromStatusSnapshot([
      {
        paneKey: 'pane-a',
        terminalHandle: 'term-a',
        state: 'working',
        stateStartedAt: 10,
        turnStartedAt: 20,
        receivedAt: 999,
        evidenceObservedAt: 100
      },
      {
        paneKey: 'pane-b',
        state: 'done',
        stateStartedAt: 1,
        receivedAt: 2,
        providerSessionOnly: true
      }
    ])
    expect(rows).toEqual([
      {
        paneKey: 'pane-a',
        terminalHandle: 'term-a',
        state: 'working',
        stateStartedAt: 10,
        turnStartedAt: 20,
        observedAt: 100
      }
    ])
  })
})

describe('timer', () => {
  it('is one unref-able interval, idempotent to start, and stops', () => {
    expect(stallSamplerRunning()).toBe(false)
    expect(startStallSampler({ intervalMs: 1_000 })).toBe(true)
    expect(startStallSampler({ intervalMs: 1_000 })).toBe(false)
    expect(stallSamplerRunning()).toBe(true)
    stopStallSampler()
    expect(stallSamplerRunning()).toBe(false)
  })
})
