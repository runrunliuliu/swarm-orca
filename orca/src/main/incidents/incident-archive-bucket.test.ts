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
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import {
  closeStorePairs,
  databasePath,
  openStorePair,
  record,
  trackDatabase
} from './incident-test-fixture'
import {
  drainEvidenceArchive,
  readEvidenceArchiveState,
  retryIncompleteArchive,
  stageIncidentEvidence,
  summarizeArchive
} from './incident-archive'

const NOW = 1_700_000_000_000

afterEach(() => {
  closeStorePairs()
})

describe('archive bucket layout', () => {
  it('puts a row with no run under _unattributed/<host_id>, and an empty run id too', () => {
    const { opened: database, store, userData } = openStorePair()
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    store.insertIncident(record({ id: 'inc_no_run', runId: null, hostId: 'host-a' }))
    store.insertIncident(record({ id: 'inc_empty_run', runId: '', hostId: 'host-b' }))
    store.insertIncident(record({ id: 'inc_named_run' }))
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
    const { opened: database, store, userData } = openStorePair()
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    store.insertIncident(record({ id: 'inc_no_host', runId: null, hostId: '' }))
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
    const { opened: database, store, userData } = openStorePair()
    store.insertIncident(record({ id: 'inc_1' }))
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

/** Event-log rows for one incident, oldest first: the audit trail the retry path must only append to. */
function eventStates(db: OpenIncidentsDatabase, incidentId = 'inc_1'): string[] {
  return (
    db.db
      .prepare(
        `SELECT state FROM incident_evidence_archive_events WHERE incident_id = ? ORDER BY id ASC`
      )
      .all(incidentId) as { state: string }[]
  ).map((row) => row.state)
}

describe('explicit retry for an incomplete pointer (G5)', () => {
  /** Stage one excerpt, then make the drain record a `sha256_mismatch`. */
  function mismatched(): { db: OpenIncidentsDatabase; userData: string; root: string; id: string } {
    const { opened: database, store, userData } = openStorePair()
    store.insertIncident(record({ id: 'inc_1' }))
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    const root = join(userData, 'archive')
    const drained = drainEvidenceArchive({
      db: database.db,
      root,
      now: NOW,
      write: (target) => writeFileSync(target, 'tampered')
    })
    expect(drained).toMatchObject({ archived: 0, incomplete: 1 })
    expect(readEvidenceArchiveState(database.db, 'inc_1')[0]).toMatchObject({
      state: 'archive_incomplete',
      error: 'sha256_mismatch'
    })
    return { db: database, userData, root, id: 'inc_1' }
  }

  it('appends one archive_pending event for a mismatch, and the next drain then archives it', () => {
    const { db, root } = mismatched()
    const before = eventStates(db)
    expect(before).toEqual(['staged', 'archive_pending', 'archive_incomplete'])

    // Capture the failed row BEFORE the retry. Comparing the appended row against `result.pointers[0]`
    // would be self-referential (that entry is derived from the post-retry row), so a re-baselining
    // implementation — one that recomputed sha256 from the staging bytes instead of carrying the
    // failed attempt's values — would still pass. These three values are the pre-retry truth.
    const [preRetry] = readEvidenceArchiveState(db.db, 'inc_1')
    expect(preRetry).toMatchObject({ state: 'archive_incomplete', error: 'sha256_mismatch' })
    expect(preRetry.stagingPath).not.toBeNull()
    expect(preRetry.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(preRetry.bytes).toBeGreaterThan(0)

    const result = retryIncompleteArchive({ db: db.db, incidentId: 'inc_1', now: NOW + 1_000 })
    expect(result).toMatchObject({ retried: 1, refused: 0 })
    expect(result.pointers).toHaveLength(1)
    expect(result.pointers[0]).toMatchObject({ pointerIndex: 0, code: 'retried', state: 'archive_pending' })

    // Append-only: exactly one new event, carrying the pre-retry staging path/sha256/bytes with no error.
    expect(eventStates(db)).toEqual([
      'staged',
      'archive_pending',
      'archive_incomplete',
      'archive_pending'
    ])
    const latest = readEvidenceArchiveState(db.db, 'inc_1')[0]
    expect(latest).toMatchObject({ state: 'archive_pending', error: null, archivePath: null })
    expect(latest.stagingPath).toBe(preRetry.stagingPath)
    expect(latest.sha256).toBe(preRetry.sha256)
    expect(latest.bytes).toBe(preRetry.bytes)

    // The ordinary drain publishes it: the retry only re-queues, it never archives by itself.
    expect(drainEvidenceArchive({ db: db.db, root, now: NOW + 2_000 })).toMatchObject({
      archived: 1,
      remaining: 0
    })
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0]).toMatchObject({
      state: 'archived',
      error: null
    })
  })

  it('refuses a second retry after the first succeeded, appending nothing', () => {
    const { db } = mismatched()
    expect(retryIncompleteArchive({ db: db.db, incidentId: 'inc_1', now: NOW + 1 }).retried).toBe(1)
    const afterFirst = eventStates(db)

    const again = retryIncompleteArchive({ db: db.db, incidentId: 'inc_1', now: NOW + 2 })
    expect(again).toMatchObject({ code: 'no_incomplete_pointer', retried: 0, refused: 1 })
    expect(again.pointers[0]).toMatchObject({ code: 'already_pending', state: 'archive_pending' })
    expect(eventStates(db)).toEqual(afterFirst)
  })

  it('refuses a retry on an archived pointer', () => {
    const { opened: database, store, userData } = openStorePair()
    store.insertIncident(record({ id: 'inc_1' }))
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    expect(
      drainEvidenceArchive({ db: database.db, root: join(userData, 'archive'), now: NOW })
    ).toMatchObject({ archived: 1 })
    const before = eventStates(database)

    const result = retryIncompleteArchive({ db: database.db, incidentId: 'inc_1', now: NOW + 1 })
    expect(result).toMatchObject({ code: 'no_incomplete_pointer', retried: 0, refused: 1 })
    expect(result.pointers[0]).toMatchObject({ code: 'already_archived', state: 'archived' })
    expect(eventStates(database)).toEqual(before)
  })

  it('refuses a retry on a pointer that is only pending, and on one never staged', () => {
    const { opened: database, store, userData } = openStorePair()
    store.insertIncident(record({ id: 'inc_1' }))
    const path = join(userData, 'transcript.jsonl')
    writeFileSync(path, 'evidence body\n')
    stageIncidentEvidence({
      db: database.db,
      incidentId: 'inc_1',
      pointers: [{ kind: 'transcript', path }],
      userDataPath: userData,
      now: NOW
    })
    const before = eventStates(database)

    const pending = retryIncompleteArchive({ db: database.db, incidentId: 'inc_1', now: NOW + 1 })
    expect(pending.pointers[0]).toMatchObject({ code: 'already_pending', state: 'archive_pending' })
    expect(eventStates(database)).toEqual(before)

    // An index that exists but is not incomplete, and one that does not exist at all, are different
    // answers: `no_incomplete_pointer` vs `unknown_pointer`.
    const wrongState = retryIncompleteArchive({
      db: database.db,
      incidentId: 'inc_1',
      pointerIndex: 0,
      now: NOW + 2
    })
    expect(wrongState.pointers[0]).toMatchObject({ code: 'already_pending' })
    const missingIndex = retryIncompleteArchive({
      db: database.db,
      incidentId: 'inc_1',
      pointerIndex: 7,
      now: NOW + 3
    })
    expect(missingIndex).toMatchObject({ code: 'unknown_pointer', retried: 0, refused: 1 })
    expect(missingIndex.pointers).toEqual([
      {
        incidentId: 'inc_1',
        pointerIndex: 7,
        code: 'unknown_pointer',
        state: null,
        stagingPath: null,
        sha256: null,
        bytes: null
      }
    ])
    expect(eventStates(database)).toEqual(before)
  })

  it('refuses with staging_missing when the staged excerpt is gone, leaving the state untouched', () => {
    const { db, userData } = mismatched()
    const [latest] = readEvidenceArchiveState(db.db, 'inc_1')
    rmSync(latest.stagingPath as string, { force: true })
    const before = eventStates(db)

    const result = retryIncompleteArchive({ db: db.db, incidentId: 'inc_1', now: NOW + 1 })
    expect(result).toMatchObject({ retried: 0, refused: 1 })
    expect(result.pointers[0]).toMatchObject({
      code: 'staging_missing',
      state: 'archive_incomplete'
    })
    expect(eventStates(db)).toEqual(before)
    expect(readEvidenceArchiveState(db.db, 'inc_1')[0]).toMatchObject({
      state: 'archive_incomplete',
      error: 'sha256_mismatch'
    })
    void userData
  })

  it('retries every incomplete pointer by default, and only the named one with pointerIndex', () => {
    const { opened: database, store, userData } = openStorePair()
    store.insertIncident(record({ id: 'inc_1' }))
    const first = join(userData, 'first.jsonl')
    const second = join(userData, 'second.jsonl')
    writeFileSync(first, 'first excerpt\n')
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
    const mismatchBoth = () =>
      drainEvidenceArchive({
        db: database.db,
        root: join(userData, 'archive'),
        now: NOW,
        write: (target) => writeFileSync(target, 'tampered')
      })
    mismatchBoth()
    expect(readEvidenceArchiveState(database.db, 'inc_1').map((state) => state.state)).toEqual([
      'archive_incomplete',
      'archive_incomplete'
    ])

    const one = retryIncompleteArchive({
      db: database.db,
      incidentId: 'inc_1',
      pointerIndex: 1,
      now: NOW + 1
    })
    expect(one).toMatchObject({ retried: 1, refused: 0 })
    expect(one.pointers.map((entry) => [entry.pointerIndex, entry.code])).toEqual([[1, 'retried']])
    expect(readEvidenceArchiveState(database.db, 'inc_1').map((state) => state.state)).toEqual([
      'archive_incomplete',
      'archive_pending'
    ])

    const all = retryIncompleteArchive({ db: database.db, incidentId: 'inc_1', now: NOW + 2 })
    expect(all).toMatchObject({ retried: 1, refused: 1 })
    expect(all.pointers.map((entry) => [entry.pointerIndex, entry.code])).toEqual([
      [0, 'retried'],
      [1, 'already_pending']
    ])
  })

  it('refuses when nothing is incomplete at all, and appends nothing', () => {
    const { opened: database, store, userData } = openStorePair()
    store.insertIncident(record({ id: 'inc_1' }))
    const before = eventStates(database)
    const result = retryIncompleteArchive({ db: database.db, incidentId: 'inc_1', now: NOW })
    expect(result).toMatchObject({ retried: 0, refused: 0, pointers: [] })
    expect(eventStates(database)).toEqual(before)
    void userData
  })

  it('holds the writer lock across the read and the append, so a second writer is refused', () => {
    const { db, userData } = mismatched()
    const dbPath = databasePath(userData)
    const before = eventStates(db)
    // Observation-only record: the seam below runs while the first call is INSIDE `BEGIN IMMEDIATE`.
    const seen: { busy: Error | null; rowsDuringLock: number | null; beganAtOnce: boolean } = {
      busy: null,
      rowsDuringLock: null,
      beganAtOnce: false
    }
    // A second connection with a short busy timeout: if the writer lock is genuinely held, this either
    // throws `database is locked` (SQLITE_BUSY) or, for a broken implementation, begins immediately.
    const second = new Database(dbPath, { timeout: 50 })
    let result: ReturnType<typeof retryIncompleteArchive> | null = null
    try {
      result = retryIncompleteArchive({
        db: db.db,
        incidentId: 'inc_1',
        now: NOW + 1,
        readStaging: (path) => {
          try {
            second.exec('BEGIN IMMEDIATE')
            seen.beganAtOnce = true
            second.exec('ROLLBACK')
          } catch (error) {
            seen.busy = error as Error
          }
          // A read is still allowed under the writer's RESERVED lock, and it must show the un-appended
          // pre-state: the append happens after this seam returns.
          const row = second
            .prepare('SELECT COUNT(*) AS n FROM incident_evidence_archive_events')
            .get() as { n: number }
          seen.rowsDuringLock = Number(row.n)
          return readFileSync(path)
        }
      })
    } finally {
      second.close()
    }

    // The lock boundary is real: the second writer could NOT begin while the first held the lock...
    expect(seen.beganAtOnce).toBe(false)
    expect(seen.busy).not.toBeNull()
    const busyError = seen.busy as { message?: string; errcode?: number } | null
    // Observed on this driver: {"message":"database is locked","code":"ERR_SQLITE_ERROR","errcode":5}.
    expect(String(busyError?.message)).toMatch(/busy|locked/i)
    if (typeof busyError?.errcode === 'number') {
      expect(busyError.errcode).toBe(5) // SQLITE_BUSY
    }
    // ...and it could see the pre-append event count, i.e. nothing of the retry had been written yet.
    expect(seen.rowsDuringLock).toBe(before.length)
    // The first call still committed its one append.
    expect(result).toMatchObject({ code: 'retried', retried: 1 })
    expect(eventStates(db)).toEqual([
      'staged',
      'archive_pending',
      'archive_incomplete',
      'archive_pending'
    ])

    // After that commit a second retry is a no-op refusal: it appends nothing (the second connection
    // still refuses to double-append, now because the latest state is pending, not because of a lock).
    const later = trackDatabase(openIncidentsDatabase(dbPath))
    const fromOther = retryIncompleteArchive({ db: later.db, incidentId: 'inc_1', now: NOW + 2 })
    expect(fromOther).toMatchObject({ code: 'no_incomplete_pointer', retried: 0, refused: 1 })
    expect(fromOther.pointers[0]).toMatchObject({ code: 'already_pending' })
    expect(eventStates(later)).toHaveLength(before.length + 1)
  })
})
