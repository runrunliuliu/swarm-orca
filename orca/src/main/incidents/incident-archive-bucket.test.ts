/**
 * Evidence externalisation (M8-4), the parts `incident-archive.test.ts` does not pin.
 *
 * Left behind by the real-filesystem archive drill (see the M8 finish report). Three guarantees the
 * state machine makes, and that the tmpdir suite in `incident-archive.test.ts` does not currently
 * exercise:
 *
 *   1. the archive bucket is `<run_id>` when the row has one and `_unattributed/<host_id>` when it
 *      does not — the documented layout has a fallback branch that had no coverage at all;
 *   2. a `sha256_mismatch` is TERMINAL for a pointer: the pending query only selects
 *      `archive_pending`, so a later drain neither retries it nor flips it to `archived`. A reader
 *      must be able to trust that `archive_incomplete` stays visible instead of quietly healing;
 *   3. a transient write failure is NOT terminal: the row stays `archive_pending` and the next drain
 *      archives it — the retry half of the same distinction.
 *
 * Nothing here duplicates the existing file: it covers staging bounds, `root = null`, the happy
 * read-back path and the immediate shape of both failure states, all of which stay there.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'
import {
  drainEvidenceArchive,
  readEvidenceArchiveState,
  stageIncidentEvidence,
  summarizeArchive
} from './incident-archive'

const NOW = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []

function pair(): { opened: OpenIncidentsDatabase; userData: string } {
  const userData = mkdtempSync(join(tmpdir(), 'orca-incident-archive-extra-'))
  directories.push(userData)
  const database = openIncidentsDatabase(join(userData, 'incidents', 'incidents.db'))
  opened.push(database)
  return { opened: database, userData }
}

function record(id: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id,
    sourceKind: 'self_report',
    sourceId: `src-${id}`,
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

describe('archive bucket layout', () => {
  it('puts a row with no run under _unattributed/<host_id>, and an empty run id too', () => {
    const { opened: database, userData } = pair()
    const store = createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes })
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    store.insertIncident(record('inc_no_run', { runId: null, hostId: 'host-a' }))
    store.insertIncident(record('inc_empty_run', { runId: '', hostId: 'host-b' }))
    store.insertIncident(record('inc_named_run', { runId: 'run-1' }))
    for (const id of ['inc_no_run', 'inc_empty_run', 'inc_named_run']) {
      expect(stageIncidentEvidence({
        db: database.db,
        incidentId: id,
        pointers: [{ kind: 'transcript', path }],
        userDataPath: userData,
        now: NOW
      })).toEqual({ staged: 1, incomplete: 0 })
    }

    const result = drainEvidenceArchive({ db: database.db, root: join(userData, 'archive'), now: NOW })
    expect(result).toMatchObject({ configured: true, archived: 3, remaining: 0 })

    const archived = new Map(
      readEvidenceArchiveState(database.db).map((state) => [state.incidentId, state.archivePath])
    )
    const relative = (id: string): string =>
      String(archived.get(id)).slice(join(userData, 'archive').length + 1)
    // The documented layout: `<root>/<run or _unattributed/<host>>/incidents/<id>/<index>-<name>`.
    expect(relative('inc_no_run')).toBe(join('_unattributed', 'host-a', 'incidents', 'inc_no_run', '0-excerpt.bin'))
    expect(relative('inc_empty_run')).toBe(join('_unattributed', 'host-b', 'incidents', 'inc_empty_run', '0-excerpt.bin'))
    expect(relative('inc_named_run')).toBe(join('run-1', 'incidents', 'inc_named_run', '0-excerpt.bin'))
  })

  it('falls back to the literal `local` host for an empty host id', () => {
    const { opened: database, userData } = pair()
    const store = createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes })
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    store.insertIncident(record('inc_no_host', { runId: null, hostId: '' }))
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_no_host',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    drainEvidenceArchive({ db: database.db, root: join(userData, 'archive'), now: NOW })
    expect(readEvidenceArchiveState(database.db, 'inc_no_host')[0].archivePath).toContain(
      join('_unattributed', 'local', 'incidents', 'inc_no_host')
    )
  })
})

describe('failure state is a distinction, not a delay', () => {
  function staged(): { db: OpenIncidentsDatabase; userData: string; root: string } {
    const { opened: database, userData } = pair()
    createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes }).insertIncident(record('inc_1'))
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    return { db: database, userData, root: join(userData, 'archive') }
  }

  it('never retries a sha256 mismatch: it stays archive_incomplete instead of healing to archived', () => {
    const { db, root } = staged()
    drainEvidenceArchive({
      db: db.db,
      root,
      now: NOW,
      write: (path) => writeFileSync(path, 'tampered')
    })
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0]).toMatchObject({
      state: 'archive_incomplete',
      error: 'sha256_mismatch'
    })

    // Later ticks: nothing is pending, so the mismatch is not rewritten and never becomes `archived`.
    for (const now of [NOW + 1_000, NOW + 2_000]) {
      expect(drainEvidenceArchive({ db: db.db, root, now })).toMatchObject({
        archived: 0,
        incomplete: 0,
        failed: 0,
        remaining: 0
      })
    }
    const states = readEvidenceArchiveState(db.db, 'inc_1')
    expect(states).toHaveLength(1)
    expect(states[0].state).toBe('archive_incomplete')
    expect(summarizeArchive(states, 1)).toMatchObject({ archived: 0, incomplete: 1, durable: false })
  })

  it('does retry a transient write failure and archives it on the next tick', () => {
    const { db, root } = staged()
    expect(
      drainEvidenceArchive({
        db: db.db,
        root,
        now: NOW,
        write: () => {
          throw new Error('ENOSPC')
        }
      })
    ).toMatchObject({ failed: 1, archived: 0, remaining: 1 })
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0].state).toBe('archive_pending')

    expect(drainEvidenceArchive({ db: db.db, root, now: NOW + 1_000 })).toMatchObject({
      archived: 1,
      failed: 0,
      remaining: 0
    })
    expect(summarizeArchive(readEvidenceArchiveState(db.db, 'inc_1'), 1)).toMatchObject({
      archived: 1,
      durable: true
    })
  })
})
