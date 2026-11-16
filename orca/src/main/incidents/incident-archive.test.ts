/**
 * Evidence externalisation (M8-4): bounded staging, append-only state, and the one rule that matters
 * most — a failed read-back is never reported as archived.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'
import {
  EVIDENCE_EXCERPT_BYTES,
  drainEvidenceArchive,
  readEvidenceArchiveState,
  stageIncidentEvidence,
  summarizeArchive
} from './incident-archive'

const NOW = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []

function pair(): { opened: OpenIncidentsDatabase; userData: string } {
  const userData = mkdtempSync(join(tmpdir(), 'orca-incident-archive-'))
  directories.push(userData)
  const database = openIncidentsDatabase(join(userData, 'incidents', 'incidents.db'))
  opened.push(database)
  return { opened: database, userData }
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: 'inc_1',
    sourceKind: 'self_report',
    sourceId: 'src-1',
    facet: 'report',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: 'run-1',
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: 'tool_error',
    status: 'untriaged',
    exitCause: null,
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: 'reported',
    createdAt: NOW,
    ...overrides
  }
}

function sourceFile(userData: string, bytes = Buffer.from('evidence body\n')): string {
  const path = join(userData, 'transcript.jsonl')
  writeFileSync(path, bytes)
  return path
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

describe('stageIncidentEvidence', () => {
  it('writes a bounded local excerpt and marks it pending, never archived', () => {
    const { opened: database, userData } = pair()
    createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes }).insertIncident(record())
    const path = sourceFile(userData)
    const result = stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path, sha256: 'a'.repeat(64), bytes: 14 }],
      userDataPath: userData,
      now: NOW
    })
    expect(result).toEqual({ staged: 1, incomplete: 0 })
    const states = readEvidenceArchiveState(database.db, 'inc_1')
    expect(states.map((state) => state.state)).toEqual(['archive_pending'])
    expect(states[0].sha256).toBe(
      createHash('sha256').update('evidence body\n').digest('hex')
    )
    expect(summarizeArchive(states)).toMatchObject({ pending: 1, archived: 0, durable: false })
    expect(statSync(states[0].stagingPath as string).size).toBe(14)
  })

  it('records an unreadable source as archive_incomplete instead of dropping the pointer', () => {
    const { opened: database, userData } = pair()
    createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes }).insertIncident(record())
    const result = stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path: join(userData, 'missing.jsonl') }],
      userDataPath: userData,
      now: NOW
    })
    expect(result.incomplete).toBe(1)
    expect(readEvidenceArchiveState(database.db, 'inc_1')[0]).toMatchObject({
      state: 'archive_incomplete',
      error: expect.stringContaining('ENOENT')
    })
  })

  it('caps the excerpt size', () => {
    const { opened: database, userData } = pair()
    createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes }).insertIncident(record())
    const path = sourceFile(userData, Buffer.alloc(EVIDENCE_EXCERPT_BYTES * 2, 7))
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    const [state] = readEvidenceArchiveState(database.db, 'inc_1')
    expect(state.bytes).toBe(EVIDENCE_EXCERPT_BYTES)
  })
})

describe('drainEvidenceArchive', () => {
  function staged(): { db: OpenIncidentsDatabase; userData: string; path: string } {
    const { opened: database, userData } = pair()
    createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes }).insertIncident(record())
    const path = sourceFile(userData)
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    return { db: database, userData, path }
  }

  it('leaves state pending when no archive root is configured', () => {
    const { db } = staged()
    const result = drainEvidenceArchive({ db: db.db, root: null, now: NOW })
    expect(result).toMatchObject({ configured: false, archived: 0, remaining: 1 })
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0].state).toBe('archive_pending')
  })

  it('archives under run/incidents/<id> only after the read-back matches', () => {
    const { db, userData } = staged()
    const root = join(userData, 'archive')
    const result = drainEvidenceArchive({ db: db.db, root, now: NOW })
    expect(result.archived).toBe(1)
    const [state] = readEvidenceArchiveState(db.db, 'inc_1')
    expect(state.state).toBe('archived')
    expect(state.archivePath).toContain(join('run-1', 'incidents', 'inc_1'))
    expect(readFileSync(state.archivePath as string).toString()).toBe('evidence body\n')
    expect(summarizeArchive([state])).toMatchObject({ archived: 1, durable: true })
  })

  it('never reports a read-back mismatch as archived', () => {
    const { db, userData } = staged()
    const root = join(userData, 'archive')
    const result = drainEvidenceArchive({
      db: db.db,
      root,
      now: NOW,
      write: (path) => writeFileSync(path, 'tampered')
    })
    expect(result.incomplete).toBe(1)
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0]).toMatchObject({
      state: 'archive_incomplete',
      error: 'sha256_mismatch'
    })
  })

  it('keeps a transient write failure pending so the next tick retries', () => {
    const { db, userData } = staged()
    const result = drainEvidenceArchive({
      db: db.db,
      root: join(userData, 'archive'),
      now: NOW,
      write: () => {
        throw new Error('ENOSPC')
      }
    })
    expect(result.failed).toBe(1)
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0].state).toBe('archive_pending')
  })
})

/**
 * Staging retention (#10): the local excerpt is reclaimed only after its `archived` event is
 * committed, and prune never removes the row that still owns the only copy.
 *
 * The distinction these cases hold: `archived` means "published and read back with a matching SHA-256",
 * so the staging file is a second copy and can go. Every earlier state means the staging file can be the
 * ONLY copy — deleting it there would destroy the material the audit claim depends on.
 */
describe('staging reclamation', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  /** A prunable (`closed`, 200 days old) incident with one staged pointer. */
  function stagedIncident(): {
    db: OpenIncidentsDatabase
    store: ReturnType<typeof createIncidentStore>
    userData: string
    stagingPath: string
    root: string
  } {
    const { opened: database, userData } = pair()
    const store = createIncidentStore({
      db: database.db,
      fileSizeBytes: database.fileSizeBytes
    })
    store.insertIncident(
      record({ id: 'inc_1', status: 'closed', createdAt: NOW - 200 * DAY_MS })
    )
    const path = sourceFile(userData)
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    const [state] = readEvidenceArchiveState(database.db, 'inc_1')
    return {
      db: database,
      store,
      userData,
      stagingPath: state.stagingPath as string,
      root: join(userData, 'archive')
    }
  }

  function eventStates(database: OpenIncidentsDatabase, incidentId = 'inc_1'): string[] {
    return (
      database.db
        .prepare(
          `SELECT state FROM incident_evidence_archive_events
            WHERE incident_id = ? ORDER BY id ASC`
        )
        .all(incidentId) as { state: string }[]
    ).map((row) => row.state)
  }

  it('removes the staging file and the empty staging directory once the pointer is archived', () => {
    const { db, stagingPath, root } = stagedIncident()
    expect(statSync(stagingPath).size).toBe(14)

    expect(drainEvidenceArchive({ db: db.db, root, now: NOW })).toMatchObject({
      archived: 1,
      remaining: 0
    })

    // The bytes are published under the archive root, so the retry copy is no longer needed.
    const [state] = readEvidenceArchiveState(db.db, 'inc_1')
    expect(state.state).toBe('archived')
    expect(readFileSync(state.archivePath as string).toString()).toBe('evidence body\n')
    expect(existsSync(stagingPath)).toBe(false)
    expect(existsSync(dirname(stagingPath))).toBe(false)
    // Reclaiming bytes never rewrites history: every event is still there, `staged` included.
    expect(eventStates(db)).toEqual(['staged', 'archive_pending', 'archived'])
  })

  it('keeps a pending pointer\'s staging bytes, which are the only copy left', () => {
    const { db, stagingPath } = stagedIncident()
    // No `ORCA_INCIDENT_ARCHIVE_ROOT` on this host: the state stays pending, the bytes must stay too.
    expect(drainEvidenceArchive({ db: db.db, root: null, now: NOW })).toMatchObject({
      configured: false,
      archived: 0
    })
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0].state).toBe('archive_pending')
    expect(statSync(stagingPath).size).toBe(14)
  })

  it('keeps the incident staging directory while a sibling pointer is still pending', () => {
    const { opened: database, userData } = pair()
    createIncidentStore({
      db: database.db,
      fileSizeBytes: database.fileSizeBytes
    }).insertIncident(record({ id: 'inc_1', status: 'closed', createdAt: NOW - 200 * DAY_MS }))
    const first = sourceFile(userData, Buffer.from('first excerpt\n'))
    const second = join(userData, 'second.jsonl')
    writeFileSync(second, 'second excerpt\n')
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [
        { kind: 'transcript', path: first },
        { kind: 'transcript', path: second }
      ],
      userDataPath: userData,
      now: NOW
    })
    const [firstState, secondState] = readEvidenceArchiveState(database.db, 'inc_1')

    const result = drainEvidenceArchive({
      db: database.db,
      root: join(userData, 'archive'),
      now: NOW,
      // The second pointer's publish fails transiently, so only the first pointer is archived.
      write: (target, bytes) => {
        if (target.includes('1-excerpt')) {
          throw new Error('ENOSPC')
        }
        writeFileSync(target, bytes)
      }
    })
    expect(result).toMatchObject({ archived: 1, failed: 1 })

    expect(existsSync(firstState.stagingPath as string)).toBe(false)
    expect(existsSync(secondState.stagingPath as string)).toBe(true)
    // Not empty: the directory is the pending pointer's, not garbage.
    expect(existsSync(dirname(secondState.stagingPath as string))).toBe(true)
  })

  it('logs a cleanup failure, keeps the bytes, and still reports the pointer archived', () => {
    const { db, stagingPath, root } = stagedIncident()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = drainEvidenceArchive({
        db: db.db,
        root,
        now: NOW,
        remove: () => {
          throw new Error('EBUSY')
        }
      })

      // A busy directory is leakage, not an archive outcome: nothing is retracted, nothing fails.
      expect(result).toMatchObject({ archived: 1, failed: 0, remaining: 0 })
      expect(readEvidenceArchiveState(db.db, 'inc_1')[0].state).toBe('archived')
      expect(existsSync(stagingPath)).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('staging cleanup failed')
    } finally {
      warn.mockRestore()
    }
  })

  it('never prunes an incident whose staging bytes are still the only retry copy', () => {
    const { db, store, stagingPath } = stagedIncident()
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0].state).toBe('archive_pending')

    // Not a candidate, and `--apply` deletes nothing: the row is the only route back to those bytes.
    expect(store.pruneIncidents({ dryRun: true, olderThanDays: 90, now: NOW })).toMatchObject({
      candidates: 0,
      candidateIds: []
    })
    expect(store.pruneIncidents({ dryRun: false, olderThanDays: 90, now: NOW })).toMatchObject({
      deleted: 0,
      deletedIds: []
    })
    expect(store.getIncident('inc_1')).not.toBeNull()
    expect(statSync(stagingPath).size).toBe(14)
  })

  it('never prunes an incomplete pointer that still holds a staging copy', () => {
    const { db, store, stagingPath, root } = stagedIncident()
    // A read-back mismatch: `archive_incomplete` plus a real staging file, which `--retry-incomplete`
    // republishes from. That file is the reason the row must stay.
    expect(
      drainEvidenceArchive({
        db: db.db,
        root,
        now: NOW,
        write: (target) => writeFileSync(target, 'tampered')
      })
    ).toMatchObject({ archived: 0, incomplete: 1 })
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0]).toMatchObject({
      state: 'archive_incomplete',
      error: 'sha256_mismatch'
    })

    expect(store.pruneIncidents({ dryRun: false, olderThanDays: 90, now: NOW }).deleted).toBe(0)
    expect(store.getIncident('inc_1')).not.toBeNull()
    expect(statSync(stagingPath).size).toBe(14)
  })

  it('prunes the row once archived, when the staging copy is already reclaimed', () => {
    const { db, store, stagingPath, root } = stagedIncident()
    drainEvidenceArchive({ db: db.db, root, now: NOW })
    expect(existsSync(stagingPath)).toBe(false)

    expect(store.pruneIncidents({ dryRun: false, olderThanDays: 90, now: NOW })).toMatchObject({
      candidates: 1,
      deleted: 1
    })
    expect(store.getIncident('inc_1')).toBeNull()
  })

  it('lets an incomplete pointer with no staging copy age out, because it owns no bytes', () => {
    const { opened: database, userData } = pair()
    const store = createIncidentStore({
      db: database.db,
      fileSizeBytes: database.fileSizeBytes
    })
    store.insertIncident(record({ id: 'inc_1', status: 'closed', createdAt: NOW - 200 * DAY_MS }))
    // Never staged: the source could not be read, so there is nothing local to protect.
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path: join(userData, 'missing.jsonl') }],
      userDataPath: userData,
      now: NOW
    })
    expect(readEvidenceArchiveState(database.db, 'inc_1')[0]).toMatchObject({
      state: 'archive_incomplete',
      stagingPath: null
    })

    expect(store.pruneIncidents({ dryRun: false, olderThanDays: 90, now: NOW }).deleted).toBe(1)
    expect(store.getIncident('inc_1')).toBeNull()
  })
})
