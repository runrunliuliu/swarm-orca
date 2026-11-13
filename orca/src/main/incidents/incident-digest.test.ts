/**
 * The digest is a set of SQL aggregates, so the only real test is "do the numbers match the database?"
 * (§10, M4-2). Uses a real store with decisions so the effective-status counts are exercised too.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import { buildIncidentDigest, parseDigestWindow } from './incident-digest'
import type { IncidentRecord } from './incident-types'
import { writeMeta } from './incident-store-capacity'
import { TOOL_ERROR_WINDOWS_META } from './incident-tool-error-report'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function fixture(): {
  store: IncidentStore
  db: OpenIncidentsDatabase['db']
  opened: OpenIncidentsDatabase
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-digest-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }),
    db: opened.db,
    opened
  }
}

function record(id: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id,
    sourceKind: 'pty_exit',
    sourceId: `src-${id}`,
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: null,
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: id,
    createdAt: NOW - 1000,
    ...overrides
  }
}

afterEach(() => {
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

describe('parseDigestWindow', () => {
  it('accepts s/m/h/d and rejects anything else', () => {
    expect(parseDigestWindow('90m')).toBe(90 * 60_000)
    expect(parseDigestWindow('24h')).toBe(DAY)
    expect(parseDigestWindow('7d')).toBe(7 * DAY)
    expect(parseDigestWindow('30s')).toBe(30_000)
    expect(parseDigestWindow('24')).toBeNull()
    expect(parseDigestWindow('one day')).toBeNull()
    expect(parseDigestWindow('')).toBeNull()
  })
})

describe('buildIncidentDigest', () => {
  it('counts by class, effective status and fingerprint exactly as the store holds them', () => {
    const { store, db } = fixture()
    store.insertIncident(record('a'))
    store.insertIncident(record('b', { class: 'tool_error', fingerprint: 'g'.repeat(64) }))
    store.insertIncident(record('c', { class: 'tool_error', fingerprint: 'g'.repeat(64) }))
    // An old row outside the window must not be counted in it.
    store.insertIncident(record('old', { createdAt: NOW - 3 * DAY }))
    // One row triaged away: it leaves `unseen` but stays in the totals.
    store.appendDecision({ incidentId: 'a', toStatus: 'invalid', actor: 'a', reason: 'r' })

    const digest = buildIncidentDigest(db, { now: NOW, windowMs: DAY, coverage: store.coverage() })
    expect(digest).toMatchObject({
      total: 3,
      unseen: 2,
      dropped: 0
    })
    expect(digest.byClass).toEqual([
      { class: 'tool_error', count: 2 },
      { class: 'crash', count: 1 }
    ])
    expect(digest.byStatus).toEqual([
      { status: 'untriaged', count: 2 },
      { status: 'invalid', count: 1 }
    ])
    expect(digest.topFingerprints[0]).toEqual({ fingerprint: 'g'.repeat(64), count: 2 })
    // The capacity block quotes the store's own coverage.
    expect(digest.capacity.rows).toBe(4)
    expect(digest.capacity.maxRows).toBe(store.coverage().capacity.maxRows)
    expect(digest.capacity.capacityLatchSet).toBe(false)
  })

  it('carries the replay state and the tool-error window snapshot', () => {
    const { store, db } = fixture()
    store.insertIncident(record('a'))
    writeMeta(db, 'shadow_dropped', '3')
    writeMeta(db, 'shadow_replay_incomplete', '1')
    writeMeta(db, 'shadow_last_stop_reason', 'budget')
    writeMeta(
      db,
      TOOL_ERROR_WINDOWS_META,
      JSON.stringify({
        updatedAt: NOW,
        writeEnabled: true,
        windows: [
          { wouldWriteIfEnabled: true },
          { wouldWriteIfEnabled: false }
        ]
      })
    )
    const digest = buildIncidentDigest(db, { now: NOW, windowMs: DAY, coverage: store.coverage() })
    expect(digest.dropped).toBe(3)
    expect(digest.shadowReplay).toMatchObject({ incomplete: true, lastStopReason: 'budget' })
    expect(digest.toolError).toMatchObject({ windows: 2, wouldWrite: 1, writeEnabled: true })
  })

  it('is empty, not wrong, for a window with no rows', () => {
    const { store, db } = fixture()
    const digest = buildIncidentDigest(db, { now: NOW, windowMs: 60_000, coverage: store.coverage() })
    expect(digest).toMatchObject({
      since: NOW - 60_000,
      total: 0,
      unseen: 0,
      byClass: [],
      byStatus: [],
      topFingerprints: []
    })
  })
})
