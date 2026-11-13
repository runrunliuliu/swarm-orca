/**
 * The pane-clock sampler (M8-2, formerly the stall sampler): facts in, facts out.
 *
 * The properties that matter after the subtraction are the ones a re-added verdict would break:
 *   * no incident is written, even for a pane quiet for hours;
 *   * a pane that disappears from the snapshot disappears from the read model;
 *   * a missing semantic clock is stored as `state_fallback`, not silently filled in;
 *   * a bad epoch is counted, not written as 0.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import { readPaneClockCoverage, readPaneClocks } from './incident-pane-clocks'
import {
  samplePaneClocks,
  stallRowsFromStatusSnapshot,
  type PaneClockSourceRow
} from './incidents-stall-sampler'
import { declareWait, pruneExpiredWaits } from './incident-wait'

const NOW = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []

function pair(): { opened: OpenIncidentsDatabase; store: IncidentStore } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pane-clock-'))
  directories.push(directory)
  const database = openIncidentsDatabase(join(directory, 'incidents.db'))
  opened.push(database)
  return {
    opened: database,
    store: createIncidentStore({
      db: database.db,
      fileSizeBytes: database.fileSizeBytes,
      now: () => NOW
    })
  }
}

function row(overrides: Partial<PaneClockSourceRow> = {}): PaneClockSourceRow {
  return {
    paneKey: 'tab-1:leaf-1',
    terminalHandle: 'term-1',
    state: 'working',
    stateStartedAt: NOW - 46 * 60_000,
    turnStartedAt: null,
    lastSemanticEventAt: NOW - 46 * 60_000,
    ...overrides
  }
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    try {
      database.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('samplePaneClocks', () => {
  it('records facts and writes no incident, however old the age is', () => {
    const { opened: database, store } = pair()
    const summary = samplePaneClocks({ db: database.db, now: NOW, rows: [row()] })
    expect(summary).toMatchObject({ panes: 1, declaredWaits: 0, skipped: 0 })
    expect(store.countIncidents()).toBe(0)
    const rows = readPaneClocks(database.db, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      state: 'working',
      ageMs: 46 * 60_000,
      ageBasis: 'event',
      observedAt: NOW
    })
    // There is no verdict field to read any more.
    expect(rows[0]).not.toHaveProperty('wouldWriteIfEnabled')
    expect(rows[0]).not.toHaveProperty('thresholdMs')
  })

  it('replaces the set, so a pane that disappeared stops being reported', () => {
    const { opened: database } = pair()
    samplePaneClocks({ db: database.db, now: NOW, rows: [row(), row({ paneKey: 'tab-2:leaf-1' })] })
    expect(readPaneClocks(database.db, NOW)).toHaveLength(2)
    samplePaneClocks({ db: database.db, now: NOW, rows: [row({ paneKey: 'tab-2:leaf-1' })] })
    expect(readPaneClocks(database.db, NOW).map((entry) => entry.paneKey)).toEqual(['tab-2:leaf-1'])
  })

  it('stores the fallback basis when the host never reported a semantic clock', () => {
    const { opened: database } = pair()
    samplePaneClocks({ db: database.db, now: NOW, rows: [row({ lastSemanticEventAt: null })] })
    expect(readPaneClocks(database.db, NOW)[0].ageBasis).toBe('state_fallback')
    expect(readPaneClocks(database.db, NOW)[0].ageMs).toBe(46 * 60_000)
  })

  it('counts an unusable epoch instead of writing it as zero', () => {
    const { opened: database } = pair()
    const summary = samplePaneClocks({ db: database.db, now: NOW, rows: [row({ stateStartedAt: Number.NaN })] })
    expect(summary.skipped).toBe(1)
    expect(summary.panes).toBe(0)
    expect(readPaneClocks(database.db, NOW)).toEqual([])
    expect(readPaneClockCoverage(database.db).skipped).toBe(1)
  })

  it('joins a declared wait for the same epoch as context', () => {
    const { opened: database } = pair()
    declareWait(database.db, {
      paneKey: 'tab-1:leaf-1',
      epoch: String(NOW - 46 * 60_000),
      reason: 'long build',
      actor: 'alice',
      expiresAt: null,
      now: NOW
    })
    samplePaneClocks({ db: database.db, now: NOW, rows: [row()] })
    const [clock] = readPaneClocks(database.db, NOW)
    expect(clock.declaredWait).toBe('long build')
    // A declaration is context now, not a suppressor: the fact row is unchanged.
    expect(clock.ageMs).toBe(46 * 60_000)
  })

  it('does not inherit a declaration across an epoch change', () => {
    const { opened: database } = pair()
    declareWait(database.db, {
      paneKey: 'tab-1:leaf-1',
      epoch: String(NOW - 46 * 60_000),
      reason: 'long build',
      actor: 'alice',
      expiresAt: null,
      now: NOW
    })
    samplePaneClocks({ db: database.db, now: NOW, rows: [row({ stateStartedAt: NOW - 60_000 })] })
    expect(readPaneClocks(database.db, NOW)[0].declaredWait).toBeNull()
  })

  it('drops expired declarations on the next sweep (still a fact, not a promise)', () => {
    const { opened: database } = pair()
    declareWait(database.db, {
      paneKey: 'tab-1:leaf-1',
      epoch: String(NOW - 46 * 60_000),
      reason: 'long build',
      actor: 'alice',
      expiresAt: NOW - 1,
      now: NOW - 2
    })
    samplePaneClocks({ db: database.db, now: NOW, rows: [row()] })
    expect(readPaneClocks(database.db, NOW)[0].declaredWait).toBeNull()
    pruneExpiredWaits(database.db, NOW)
  })

  it('publishes coverage counts that distinguish "no panes" from "sampler failed"', () => {
    const { opened: database } = pair()
    samplePaneClocks({ db: database.db, now: NOW, rows: [] })
    expect(readPaneClockCoverage(database.db)).toMatchObject({
      sampledAt: NOW,
      panes: 0,
      declaredWaits: 0,
      errors: 0
    })
  })
})

describe('stallRowsFromStatusSnapshot', () => {
  it('carries the semantic clock through unchanged and skips provider-session-only rows', () => {
    const rows = stallRowsFromStatusSnapshot([
      {
        paneKey: 'pane-1',
        terminalHandle: 'term-1',
        state: 'working',
        stateStartedAt: 10,
        turnStartedAt: 9,
        evidenceObservedAt: 8,
        receivedAt: 11
      },
      {
        paneKey: 'pane-2',
        state: 'working',
        stateStartedAt: 10,
        evidenceObservedAt: 8,
        receivedAt: 11,
        providerSessionOnly: true
      }
    ])
    expect(rows).toEqual([
      {
        paneKey: 'pane-1',
        terminalHandle: 'term-1',
        state: 'working',
        stateStartedAt: 10,
        turnStartedAt: 9,
        lastSemanticEventAt: 8
      }
    ])
  })
})
