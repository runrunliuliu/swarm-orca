/**
 * Evidence externalisation (M8-4): bounded staging, append-only state, and the one rule that matters
 * most — a failed read-back is never reported as archived.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
