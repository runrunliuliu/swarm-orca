/**
 * The M7 merge seam: three branches' halves, wired, against a real SQLite file.
 *
 * This file exists because none of the three branches could test the *joint*. A's counts and badge,
 * B's grading and panel DTOs, and C's mirror read were each proven in place; what was never proven is
 * that registering C's reader once changes only the secondary hint, and that the local verdict survives
 * it. So every case here goes through the real pipeline:
 *
 *   real store → `installIncidentMirrorCoverageReader()` (the production registration) → the mirror's
 *   own link rows → `readIncidentCountsSnapshot` / `readIncidentSnapshot` → the badge/banner mapping.
 *
 * The rule under test is the pre-merge review's must-fix #1: a remote hole may add a secondary hint and
 * must never enter `coverage.gap`, re-tone the badge, or change the untriaged number. The counterpart is
 * B's fix 2: a local hole under a zero count is still not silence.
 *
 * The badge/banner modules are the renderer's pure mapping functions (no React, no i18n), imported here
 * so the assertion is on the decision a user sees, not on a DTO field alone.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncidentRecord } from '../incidents/incident-types'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../incidents/incident-store'
import { ensureMirrorLink, recordMirrorProbeSuccess } from '../incidents/incident-mirror-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../incidents/incident-writer'
import { readIncidentCountsSnapshot, readIncidentSnapshot } from './incidents'
import { __resetIncidentCountsPushForTests } from './incident-counts-push'
import {
  readIncidentRemoteMirror,
  resetIncidentMirrorCoverageReaderForTests
} from './incident-mirror-coverage'
import {
  installIncidentMirrorCoverageReader,
  toIncidentRemoteMirrorDto
} from './incident-mirror-coverage-install'
import { incidentBadgeFromCounts } from '../../renderer/src/components/right-sidebar/incident-badge'
import { incidentRemoteCoverageLine } from '../../renderer/src/components/right-sidebar/incidents/incident-coverage-banner'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const NOW = 1_700_000_000_000
const ORIGIN_HOST = 'host-origin'
const CAPACITY_LATCH_KEY = 'capacity_limited'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function openStore(): { store: IncidentStore; opened: OpenIncidentsDatabase } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-seam-'))
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
    id: 'inc_seam_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-seam-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-seam-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'unknown', reason: 'stop_unverified' },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: 'stop never confirmed',
    createdAt: NOW,
    ...overrides
  }
}

/** The same durable latch the capacity gate writes when it refuses a row. */
function latchCapacity(db: OpenIncidentsDatabase['db']): void {
  db.prepare(
    `INSERT INTO incident_store_meta (key, value) VALUES ('${CAPACITY_LATCH_KEY}', '1')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run()
}

/** An origin registered but never read: `not_probed`, and nobody has stated a count. */
function registerNeverProbedOrigin(db: OpenIncidentsDatabase['db']): void {
  ensureMirrorLink(db, ORIGIN_HOST, NOW)
}

/** An origin read to a cursor, with the count it stated still outstanding. */
function mirrorOrigin(db: OpenIncidentsDatabase['db'], pending: number | null): void {
  ensureMirrorLink(db, ORIGIN_HOST, NOW)
  recordMirrorProbeSuccess(db, {
    hostId: ORIGIN_HOST,
    now: NOW + 1_000,
    cursor: 7,
    pending,
    inserted: 2,
    duplicates: 0,
    rejected: 0,
    dropped: 0,
    pruned: 0,
    skippedRows: 0,
    skippedRanges: 0,
    lastSkippedReason: null,
    lastRejectedReason: null,
    lines: 2,
    ms: 5
  })
}

function counts(store: IncidentStore, opened: OpenIncidentsDatabase) {
  __configureIncidentStoreForTests(store, opened.db)
  const result = readIncidentCountsSnapshot(undefined)
  if (!result.ok) {
    throw new Error(`counts unavailable: ${result.code}`)
  }
  return result.value
}

function coverage(store: IncidentStore, opened: OpenIncidentsDatabase) {
  __configureIncidentStoreForTests(store, opened.db)
  const result = readIncidentSnapshot({ limit: 50 })
  if (!result.ok) {
    throw new Error(`snapshot unavailable: ${result.code}`)
  }
  return result.value.coverage
}

afterEach(() => {
  vi.restoreAllMocks()
  __resetIncidentWriterForTests()
  __resetIncidentCountsPushForTests()
  resetIncidentMirrorCoverageReaderForTests()
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

describe('M7 merge seam: local coverage and the remote mirror', () => {
  it('draws a capacity latch as solid local amber and never lets the mirror re-tone it', () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    store.insertIncident(record({ id: 'inc_seam_2', sourceId: 'ptyinc-seam-2' }))
    latchCapacity(opened.db)
    // A configured peer with no completed pull: the strongest remote claim there is, on purpose — if a
    // remote hole could ever re-tone, this is the case that would show it.
    registerNeverProbedOrigin(opened.db)
    installIncidentMirrorCoverageReader()

    const value = counts(store, opened)
    expect(value.untriaged).toBe(2)
    expect(value.coverage).toMatchObject({
      capacityLatchSet: true,
      currentlyLimited: false,
      gap: true,
      remoteMirror: { capture: 'not_probed', monitored: true }
    })

    const badge = incidentBadgeFromCounts(value)
    expect(badge).not.toBeNull()
    expect(badge).toMatchObject({
      count: 2,
      // Solid amber = the local number is a floor. The remote marker is additive, not a second tone.
      tone: 'caution',
      localGap: true,
      remoteGap: true,
      showCount: true
    })
    expect(badge?.label).toContain('a past capacity stop may have dropped incidents')
    expect(badge?.label).toContain('remote view incomplete')
  })

  it('keeps a remote hole secondary: coverage.gap stays false and untriaged does not move', () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    store.insertIncident(record({ id: 'inc_seam_2', sourceId: 'ptyinc-seam-2' }))
    installIncidentMirrorCoverageReader()

    // Baseline: the same two rows with no mirror at all.
    const before = counts(store, opened)
    expect(before.untriaged).toBe(2)
    expect(before.coverage.gap).toBe(false)
    expect(before.coverage.remoteMirror).toMatchObject({ capture: 'unsupported', monitored: false })

    // `not_probed`: registered, never read — "unknown", and the number of unsynchronised rows was never
    // stated, so it must not arrive as 0 either.
    registerNeverProbedOrigin(opened.db)
    const notProbed = counts(store, opened)
    expect(notProbed.untriaged).toBe(before.untriaged)
    expect(notProbed.byClass).toEqual(before.byClass)
    expect(notProbed.coverage.gap).toBe(false)
    expect(notProbed.coverage.remoteMirror).toEqual({
      capture: 'not_probed',
      unsynced: null,
      monitored: true
    })
    expect(incidentBadgeFromCounts(notProbed)).toMatchObject({
      count: 2,
      tone: 'alert',
      localGap: false,
      remoteGap: true,
      showCount: true
    })

    // `mirrored` with rows the origin says are still outstanding: the same primary verdict.
    mirrorOrigin(opened.db, 4)
    const mirrored = counts(store, opened)
    expect(mirrored.untriaged).toBe(before.untriaged)
    expect(mirrored.coverage.gap).toBe(false)
    expect(mirrored.coverage.remoteMirror).toMatchObject({
      capture: 'mirrored',
      unsynced: 4,
      monitored: true
    })
    const badge = incidentBadgeFromCounts(mirrored)
    expect(badge).toMatchObject({ count: 2, tone: 'alert', localGap: false, remoteGap: true })
    expect(badge?.label).toBe('2 untriaged (remote view incomplete)')

    // The snapshot carries the same separation: `coverage.gap` is not even a field there, and the
    // mirror's detail is reduced to three facts — the row-level read stays `orca incident mirror`.
    const snapshotCoverage = coverage(store, opened)
    expect(snapshotCoverage.remoteMirror).toEqual({
      capture: 'mirrored',
      unsynced: 4,
      monitored: true
    })
  })

  it('is not silent when a zero count sits over a local hole', () => {
    const { store, opened } = openStore()
    latchCapacity(opened.db)
    installIncidentMirrorCoverageReader()

    const value = counts(store, opened)
    expect(value.untriaged).toBe(0)
    expect(value.coverage.gap).toBe(true)

    // Zero with a gap is a badge with no digits, never `null` (which would read as "no incidents").
    const badge = incidentBadgeFromCounts(value)
    expect(badge).not.toBeNull()
    expect(badge).toMatchObject({
      count: 0,
      tone: 'caution',
      localGap: true,
      showCount: false
    })
    expect(badge?.label).toContain('a past capacity stop may have dropped incidents')
  })

  it('is a quiet marker, not a number, when zero is complete locally and only the peer is behind', () => {
    const { store, opened } = openStore()
    registerNeverProbedOrigin(opened.db)
    installIncidentMirrorCoverageReader()

    const value = counts(store, opened)
    expect(value.untriaged).toBe(0)
    expect(value.coverage.gap).toBe(false)

    const badge = incidentBadgeFromCounts(value)
    expect(badge).not.toBeNull()
    expect(badge).toMatchObject({
      count: 0,
      // Not amber: this host's own zero is complete. The remote hole is the only reason anything shows,
      // so the marker is secondary and the label carries the caveat.
      tone: 'alert',
      localGap: false,
      remoteGap: true,
      showCount: false
    })
    expect(badge?.label).toBe('remote view incomplete')
    expect(badge?.label).not.toMatch(/\d/)

    // The panel's single remote line agrees with the badge: a stated gap, not a count.
    const line = incidentRemoteCoverageLine(coverage(store, opened))
    expect(line).toEqual({ state: 'gap', capture: 'not_probed', unsynced: null, gap: true })
  })

  it('reports no remoteMirror at all until the reader is installed, and never as false/0', () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    registerNeverProbedOrigin(opened.db)

    // Nothing registered: "not reported". The key must be absent, because `{ unsynced: 0 }` would be a
    // claim ("caught up") that no mirror made.
    expect(readIncidentRemoteMirror(opened.db)).toBeUndefined()
    const beforeCounts = counts(store, opened)
    const beforeSnapshot = coverage(store, opened)
    expect('remoteMirror' in beforeCounts.coverage).toBe(false)
    expect('remoteMirror' in beforeSnapshot).toBe(false)

    installIncidentMirrorCoverageReader()
    const afterCounts = counts(store, opened)
    const afterSnapshot = coverage(store, opened)
    expect(afterCounts.coverage.remoteMirror).toEqual({
      capture: 'not_probed',
      unsynced: null,
      monitored: true
    })
    expect(afterSnapshot.remoteMirror).toEqual({
      capture: 'not_probed',
      unsynced: null,
      monitored: true
    })

    // Installing the reader is not a coverage change: the local verdict and the number are identical.
    expect(afterCounts.untriaged).toBe(beforeCounts.untriaged)
    expect(afterCounts.coverage.gap).toBe(beforeCounts.coverage.gap)
    expect(afterCounts.coverage).toMatchObject({
      currentlyLimited: beforeCounts.coverage.currentlyLimited,
      capacityLatchSet: beforeCounts.coverage.capacityLatchSet,
      shadowReplayIncomplete: beforeCounts.coverage.shadowReplayIncomplete
    })
  })

  it('adapts the mirror read without inventing a count or a gap', () => {
    // The adapter is the only place both shapes are known; these are the three decisions it makes.
    expect(
      toIncidentRemoteMirrorDto({
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
        provenanceConflicts: 0
      })
    ).toEqual({ capture: 'unsupported', unsynced: null, monitored: false })

    // An unstated count stays unstated: `null` is not a zero, and the panel grades it as a gap.
    expect(
      toIncidentRemoteMirrorDto({
        capture: 'mirrored',
        hosts: [],
        unsynced: null,
        unsyncedAsOf: null,
        unreachable: 1,
        rejected: 0,
        pruned: 0,
        lastError: 'unreachable',
        mirroredRowsPresent: 2,
        skippedRows: 0,
        provenanceConflicts: 0
      })
    ).toEqual({ capture: 'mirrored', unsynced: null, monitored: true })
  })
})
