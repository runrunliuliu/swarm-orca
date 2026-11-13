/**
 * The remote mirror (issue-sedimentation.md §11.1, M7-C).
 *
 * What these cases pin, in the order the milestone was specified:
 *   1. a successful pull mirrors origin facts without this host claiming to have observed them;
 *   2. a failed pull keeps the cursor AND the retained unsynced count — never "caught up";
 *   3. a reconnect is just another pull: the same range is absorbed by the store's existing
 *      UNIQUE(source_kind, source_id, facet) key, so losing the cursor costs time, not rows;
 *   4. the three-state answer is derived, never defaulted: `unsupported` (nothing registered),
 *      `not_probed` (registered, never read — unknown, not zero), `mirrored`;
 *   5. one fact is one row: a key this host already owns is refused and counted, a pruned fact is not
 *      resurrected, two origins exporting one fact produce one row, and a feed may not file a record
 *      under another host's id.
 *
 * Everything here uses a fake host. No socket, no SSH relay, no real remote machine: a live
 * cross-host pull has NOT been run (see the M7-C report).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'
import { shadowRecordFromIncident } from './incident-shadow'
import {
  __resetMirrorFeedsForTests,
  listMirrorFeeds,
  registerMirrorFeed,
  syncIncidentMirror,
  type MirrorFeed,
  type MirrorPage
} from './incident-mirror-sync'
import {
  readIncidentMirrorCoverage,
  readMirrorProvenance
} from './incident-mirror-store'
import {
  formatIncidentMirrorCoverage,
  formatIncidentMirrorJson
} from '../../cli/incident-mirror-format'
import {
  __resetIncidentShadowStartupForTests,
  syncIncidentMirrorAtStartup
} from './incidents-startup'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from './incident-writer'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function openStore(): { store: IncidentStore; opened: OpenIncidentsDatabase } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-mirror-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }),
    opened
  }
}

afterEach(() => {
  __resetMirrorFeedsForTests()
  __resetIncidentShadowStartupForTests()
  __resetIncidentWriterForTests()
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

type HostRecord = { seq: number; record: IncidentRecord }

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: 'inc_local_1',
    sourceKind: 'pty_exit',
    sourceId: 'inc-pty-1',
    facet: 'exit',
    hostId: 'this-host',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'inc-pty-1',
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

/** The origin's own rows, as it would export them (the shadow line is the wire, §11.2). */
function originRecords(hostId: string, count: number): HostRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    record: record({
      id: `inc_${hostId}_${index + 1}`,
      sourceId: `pty-${hostId}-${index + 1}`,
      ptyIncarnationId: `pty-${hostId}-${index + 1}`,
      hostId,
      class: index === 0 ? 'crash' : 'tool_error',
      fingerprint: String(index + 1).repeat(64)
    })
  }))
}

function shadowLines(records: HostRecord[]): string[] {
  return records.map((entry) =>
    JSON.stringify({ ...shadowRecordFromIncident(entry.record, NOW), seq: entry.seq })
  )
}

/**
 * A fake origin host: serves its own lines, pages like a transport would, and can be told to fail.
 *
 * `failWith` is a mutable field rather than a per-call option so a test can flip a healthy link to a
 * dead one between pulls — exactly the reconnect story.
 */
type FakeHost = MirrorFeed & {
  failWith: Error | null
  reads: number
  lines: string[]
  pendingOverride: number | null
}

function fakeHost(
  hostId: string,
  records: HostRecord[],
  options: { pageSize?: number } = {}
): FakeHost {
  const lines = shadowLines(records)
  const host: FakeHost = {
    hostId,
    failWith: null,
    reads: 0,
    lines,
    // `pendingOverride` lets a test state a count the served lines do not imply, which is how a real
    // origin reports rows it has not exported yet.
    pendingOverride: null,
    read(request: { afterSeq: number; limit: number }): MirrorPage {
      host.reads += 1
      if (host.failWith !== null) {
        throw host.failWith
      }
      const limit = Math.min(request.limit, options.pageSize ?? request.limit)
      const remaining = host.lines.filter((line) => JSON.parse(line).seq > request.afterSeq)
      const page = remaining.slice(0, limit)
      const parsed = page.map((line) => JSON.parse(line).seq as number)
      const nextSeq = parsed.length > 0 ? Math.max(...parsed) : request.afterSeq
      const left = remaining.length - page.length
      return {
        lines: page,
        nextSeq,
        hasMore: left > 0,
        pending: host.pendingOverride ?? (left > 0 ? left : 0)
      }
    }
  }
  return host
}

async function pull(
  store: IncidentStore,
  opened: OpenIncidentsDatabase,
  feeds: readonly MirrorFeed[],
  options: { maxLinesPerHost?: number; pageSize?: number } = {}
) {
  return syncIncidentMirror({
    store,
    db: opened.db,
    feeds,
    now: () => NOW,
    ...options
  })
}

describe('mirror success', () => {
  it('mirrors origin facts with their origin host id and records the provenance', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 2))

    const summary = await pull(store, opened, [host])

    expect(summary.ran).toBe(true)
    expect(summary.hosts[0]).toMatchObject({
      hostId: 'host-a',
      inserted: 2,
      duplicates: 0,
      rejected: 0,
      dropped: 0,
      pending: 0,
      stopped: null,
      reachedOrigin: true
    })

    const list = store.listIncidents()
    expect(list.total).toBe(2)
    // The origin's host id is preserved. A mirror that rewrote it to this host would make the read
    // model claim an observation that never happened.
    expect(list.incidents.every((item) => item.hostId === 'host-a')).toBe(true)
    expect(readMirrorProvenance(opened.db, 'inc_host-a_1')).toEqual({
      incidentId: 'inc_host-a_1',
      hostId: 'host-a',
      originSeq: 1,
      pulledAt: NOW
    })

    const coverage = readIncidentMirrorCoverage(opened.db)
    expect(coverage).toMatchObject({
      capture: 'mirrored',
      unsynced: 0,
      unreachable: 0,
      rejected: 0,
      pruned: 0,
      lastError: null,
      mirroredRowsPresent: 2
    })
    expect(coverage.hosts[0]).toMatchObject({
      hostId: 'host-a',
      state: 'mirrored',
      lastCursor: 2,
      unsynced: 0,
      mirroredRows: 2,
      rowsPresent: 2,
      failureCount: 0
    })
  })

  it('leaves locally written rows without provenance and keeps the shared coverage object untouched', async () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    expect(readMirrorProvenance(opened.db, 'inc_local_1')).toBeNull()

    // The merge seam (documented in incident-mirror-types.ts): until M7-B adds the one line to
    // `incident-store-capacity.coverage()`, the shared object still reports the M1 value while the
    // mirror axis is read through this module / `orca incident mirror`.
    expect(store.coverage().remoteIncidentCapture).toBe('unsupported')
    expect(readIncidentMirrorCoverage(opened.db).capture).toBe('unsupported')
  })
})

describe('mirror failure keeps the gap visible', () => {
  it('retains the unsynced count and the cursor when the link goes down', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 3))

    // Partial pull: one line of three, so the origin still says two are unsynced.
    const first = await pull(store, opened, [host], { maxLinesPerHost: 1 })
    expect(first.hosts[0]).toMatchObject({ inserted: 1, pending: 2 })
    expect(first.hosts[0].stopped?.reason).toBe('budget')
    expect(readIncidentMirrorCoverage(opened.db).unsynced).toBe(2)

    host.failWith = new Error('ssh relay closed')
    const second = await pull(store, opened, [host])

    expect(second.hosts[0].inserted).toBe(0)
    expect(second.hosts[0].error).toContain('feed_error')
    expect(second.hosts[0].cursorAfter).toBe(1)

    const coverage = readIncidentMirrorCoverage(opened.db)
    expect(coverage.capture).toBe('mirrored')
    // The retained number, with the timestamp it was stated at: not zero, not a fresh reading.
    expect(coverage.unsynced).toBe(2)
    expect(coverage.unsyncedAsOf).toBe(NOW)
    expect(coverage.unreachable).toBe(1)
    expect(coverage.lastError).toContain('feed_error')
    expect(coverage.hosts[0]).toMatchObject({ failureCount: 1, lastCursor: 1 })
    // Nothing was written on failure: a link error is a link fact, not a fabricated incident.
    expect(store.listIncidents().total).toBe(1)
  })

  it('clears the error and the backlog once the link recovers', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 2))
    host.failWith = new Error('connection refused')
    await pull(store, opened, [host])
    expect(readIncidentMirrorCoverage(opened.db).capture).toBe('not_probed')
    expect(readIncidentMirrorCoverage(opened.db).lastError).toContain('feed_error')

    host.failWith = null
    const recovered = await pull(store, opened, [host])
    expect(recovered.hosts[0].inserted).toBe(2)
    const coverage = readIncidentMirrorCoverage(opened.db)
    expect(coverage).toMatchObject({
      capture: 'mirrored',
      unsynced: 0,
      unreachable: 0,
      lastError: null
    })
    expect(coverage.hosts[0].lastSuccessAt).toBe(NOW)
  })
})

describe('reconnect resync is idempotent', () => {
  it('re-pulls the same range without adding a row, even after the cursor is lost', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 3))

    const first = await pull(store, opened, [host])
    expect(first.inserted).toBe(3)
    expect(store.listIncidents().total).toBe(3)

    // A reconnect with a saved cursor asks for rows strictly after it, so a healthy link re-offers
    // nothing at all — that is the optimization working, not a silent gap.
    const second = await pull(store, opened, [host])
    expect(second).toMatchObject({ inserted: 0, duplicates: 0 })
    expect(store.listIncidents().total).toBe(3)

    // Losing the cursor is the failure this design must tolerate: the watermark is progress, not
    // correctness, and the store's UNIQUE(source_kind, source_id, facet) key absorbs the replay.
    opened.db.prepare('UPDATE incident_mirror_links SET last_cursor = 0').run()
    const third = await pull(store, opened, [host])
    expect(third).toMatchObject({ inserted: 0, duplicates: 3 })
    expect(store.listIncidents().total).toBe(3)
    // The provenance still names the same origin seq for each fact.
    expect(readMirrorProvenance(opened.db, 'inc_host-a_3')?.originSeq).toBe(3)
  })
})

describe('the three-state read model', () => {
  it('reports unsupported, then not_probed (unknown), then mirrored', async () => {
    const { store, opened } = openStore()

    // 1. No origin registered: a scope statement, not "no incidents anywhere".
    expect(readIncidentMirrorCoverage(opened.db)).toMatchObject({
      capture: 'unsupported',
      hosts: [],
      unsynced: null,
      unreachable: 0
    })

    // 2. Registered but never read: unknown. `unsynced` must be null, never 0.
    const host = fakeHost('host-a', originRecords('host-a', 2))
    host.failWith = new Error('handshake failed')
    await pull(store, opened, [host])
    const unknown = readIncidentMirrorCoverage(opened.db)
    expect(unknown.capture).toBe('not_probed')
    expect(unknown.unsynced).toBeNull()
    expect(unknown.hosts[0].state).toBe('not_probed')
    expect(unknown.hosts[0].lastSuccessAt).toBeNull()
    expect(unknown.hosts[0].lastError).toContain('feed_error')
    expect(unknown.unreachable).toBe(1)

    // 3. One completed pull makes it mirrored, and per-host detail survives.
    host.failWith = null
    await pull(store, opened, [host])
    expect(readIncidentMirrorCoverage(opened.db).capture).toBe('mirrored')
    expect(readIncidentMirrorCoverage(opened.db).hosts).toHaveLength(1)
  })

  it('registers the link before the first read, so a mid-flight death is a visible not_probed host', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 1))
    host.failWith = new Error('timeout')
    await pull(store, opened, [host])
    const row = opened.db
      .prepare('SELECT first_probe_at, last_probe_at, last_probe_ok FROM incident_mirror_links')
      .get()
    expect(row).toMatchObject({ first_probe_at: NOW, last_probe_at: NOW, last_probe_ok: 0 })
  })
})

describe('cross-host dedupe', () => {
  it('refuses a mirrored fact whose key this host already owns instead of adding a second row', async () => {
    const { store, opened } = openStore()
    const origin = originRecords('host-a', 1)[0].record
    // Same (source_kind, source_id, facet) as the origin's fact, written by this host.
    store.insertIncident({ ...origin, id: 'inc_local_owner', hostId: 'this-host' })
    expect(store.listIncidents().total).toBe(1)

    const host = fakeHost('host-a', originRecords('host-a', 1))
    const summary = await pull(store, opened, [host])

    expect(summary.hosts[0]).toMatchObject({
      inserted: 0,
      duplicates: 0,
      rejected: 1,
      stopped: null
    })
    // One fact, one row: the local row was kept and the refusal is counted, not hidden.
    expect(store.listIncidents().total).toBe(1)
    expect(store.listIncidents().incidents[0].hostId).toBe('this-host')
    const coverage = readIncidentMirrorCoverage(opened.db)
    expect(coverage.rejected).toBe(1)
    expect(coverage.hosts[0].lastRejectedReason).toContain('key_owned_locally')
    // The cursor moves past a line that will never become insertable, so one stale key cannot block
    // the host forever (the same policy as a capacity-dropped shadow line, M2-C3).
    expect(coverage.hosts[0].lastCursor).toBe(1)
  })

  it('does not resurrect a mirrored fact an operator pruned after triage', async () => {
    const { store, opened } = openStore()
    const old = originRecords('host-a', 1)[0]
    old.record.createdAt = NOW - 400 * DAY
    const host = fakeHost('host-a', [old])
    await pull(store, opened, [host])
    expect(store.listIncidents().total).toBe(1)

    // The real triage path: mark it invalid, then prune.
    store.appendDecision({
      incidentId: 'inc_host-a_1',
      toStatus: 'invalid',
      actor: 'operator',
      reason: 'not a real failure'
    })
    const pruned = store.pruneIncidents({ dryRun: false, now: NOW })
    expect(pruned.deleted).toBe(1)
    expect(store.listIncidents().total).toBe(0)
    // Provenance stays (it is the tombstone) but "rows present" must stop counting it.
    expect(readIncidentMirrorCoverage(opened.db).mirroredRowsPresent).toBe(0)
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].rowsPresent).toBe(0)

    // Reconnect with a lost cursor re-offers the fact; the provenance row is the tombstone.
    opened.db.prepare('UPDATE incident_mirror_links SET last_cursor = 0').run()
    const again = await pull(store, opened, [host])
    expect(again.hosts[0]).toMatchObject({ inserted: 0, pruned: 1, stopped: null })
    expect(store.listIncidents().total).toBe(0)
    expect(readIncidentMirrorCoverage(opened.db).pruned).toBe(1)
  })

  it('heals a mirrored row whose provenance write was lost, instead of calling it a local conflict', async () => {
    const { store, opened } = openStore()
    const origin = originRecords('host-a', 1)[0]
    // The half-write this test simulates: the incident row landed (with the origin's host_id) but the
    // provenance row did not. The key is taken, yet this is a mirrored row, not a local one.
    store.insertIncident({ ...origin.record, id: 'inc_host_a_partial' })
    expect(readMirrorProvenance(opened.db, 'inc_host_a_partial')).toBeNull()

    const host = fakeHost('host-a', [origin])
    const summary = await pull(store, opened, [host])

    expect(summary.hosts[0]).toMatchObject({
      inserted: 0,
      duplicates: 1,
      rejected: 0,
      stopped: null
    })
    expect(store.listIncidents().total).toBe(1)
    // Provenance is healed, so the tombstone and the dedupe classification work from now on.
    expect(readMirrorProvenance(opened.db, 'inc_host_a_partial')).toMatchObject({
      hostId: 'host-a',
      originSeq: 1
    })
    expect(readIncidentMirrorCoverage(opened.db).rejected).toBe(0)
  })

  it('keeps one row when two origins export the same fact key', async () => {
    const { store, opened } = openStore()
    // A roaming entity observed on both hosts: same fact key, different host_id per origin.
    const shared = { sourceKind: 'pty_exit' as const, sourceId: 'shared-session', facet: 'exit' }
    const hostA = fakeHost('host-a', [
      { seq: 1, record: record({ id: 'inc_a_shared', hostId: 'host-a', ...shared }) }
    ])
    const hostB = fakeHost('host-b', [
      { seq: 1, record: record({ id: 'inc_b_shared', hostId: 'host-b', ...shared }) }
    ])

    const summary = await pull(store, opened, [hostA, hostB])

    expect(summary.hosts[0]).toMatchObject({ hostId: 'host-a', inserted: 1 })
    expect(summary.hosts[1]).toMatchObject({
      hostId: 'host-b',
      inserted: 0,
      duplicates: 1,
      crossOriginDuplicates: 1
    })
    // One fact, one row — and the overlap is counted rather than hidden inside "duplicates".
    expect(store.listIncidents().total).toBe(1)
  })

  it('refuses a feed that speaks for another host instead of filing the fact under it', async () => {
    const { store, opened } = openStore()
    const hostA = fakeHost('host-a', originRecords('host-a', 1))
    const hostB = fakeHost('host-b', [
      // A line whose own host_id says host-a: host-b's feed may not speak for host-a.
      { seq: 1, record: originRecords('host-a', 1)[0].record }
    ])

    const summary = await pull(store, opened, [hostA, hostB])

    expect(summary.hosts[0]).toMatchObject({ hostId: 'host-a', inserted: 1 })
    expect(summary.hosts[1]).toMatchObject({
      hostId: 'host-b',
      inserted: 0,
      cursorAfter: 0,
      stopped: { reason: 'foreign_host' }
    })
    // Still one row for the fact: the second feed contributed nothing rather than a duplicate.
    expect(store.listIncidents().total).toBe(1)
    expect(readIncidentMirrorCoverage(opened.db).unreachable).toBe(1)
  })
})

describe('protocol violations stop instead of guessing', () => {
  it('applies the readable prefix of a page, then stops at the line it cannot read', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 2))
    const broken = JSON.stringify({ ...JSON.parse(host.lines[0]), v: 1 })
    host.lines = [host.lines[0], broken]

    const summary = await pull(store, opened, [host])
    // Same policy as the shadow replay: stop at the last good seq, do not lose it.
    expect(summary.hosts[0].inserted).toBe(1)
    expect(summary.hosts[0].stopped).toMatchObject({ reason: 'unsupported_version' })
    expect(summary.hosts[0].cursorAfter).toBe(1)
    expect(store.listIncidents().total).toBe(1)
    const coverage = readIncidentMirrorCoverage(opened.db)
    expect(coverage.hosts[0].lastCursor).toBe(1)
    expect(coverage.hosts[0].lastError).toContain('unsupported_version')
  })

  it('applies the whole readable prefix in one pass, not one line per pass', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 3))
    const broken = JSON.stringify({ ...JSON.parse(host.lines[2]), v: 1 })
    host.lines = [host.lines[0], host.lines[1], broken]

    const summary = await pull(store, opened, [host])
    // Two good lines, then an unreadable one: both good ones land now, the stop keeps the last good
    // seq, and the next pass resumes from there (no row is ever skipped).
    expect(summary.hosts[0].inserted).toBe(2)
    expect(summary.hosts[0].stopped).toMatchObject({ reason: 'unsupported_version' })
    expect(summary.hosts[0].cursorAfter).toBe(2)
    expect(store.listIncidents().total).toBe(2)
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].lastCursor).toBe(2)
  })

  it('applies none of a page whose seqs are out of order, so no row is skipped behind the cursor', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 3))
    // [3, 1, 2] with nextSeq 3: an apply-as-you-go loop would move the cursor to 3 and then skip 1/2
    // forever. The page must be refused before anything from it lands.
    host.lines = [host.lines[2], host.lines[0], host.lines[1]]

    const summary = await pull(store, opened, [host])
    expect(summary.hosts[0].inserted).toBe(0)
    expect(summary.hosts[0].stopped).toMatchObject({ reason: 'page_mismatch' })
    expect(summary.hosts[0].stopped?.detail).toContain('not_after')
    expect(summary.hosts[0].cursorAfter).toBe(0)
    expect(store.listIncidents().total).toBe(0)
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].lastCursor).toBe(0)
  })

  it('refuses a page that claims more work but offers none, instead of looping forever', async () => {
    const { store, opened } = openStore()
    let reads = 0
    const stalled: MirrorFeed = {
      hostId: 'host-a',
      read: () => {
        reads += 1
        return { lines: [], nextSeq: 0, hasMore: true, pending: 4 }
      }
    }

    const summary = await pull(store, opened, [stalled])
    expect(reads).toBe(1)
    expect(summary.hosts[0].stopped).toMatchObject({
      reason: 'page_mismatch',
      detail: 'no_progress_page'
    })
    expect(summary.hosts[0].cursorAfter).toBe(0)
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].lastCursor).toBe(0)
    expect(store.listIncidents().total).toBe(0)
  })

  it('refuses a page whose nextSeq goes backwards, keeping the cursor where it was', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 1))
    const lying: MirrorFeed = {
      hostId: 'host-a',
      read: () => ({ lines: [], nextSeq: 0, hasMore: true, pending: 1 })
    }
    // Move the cursor forward first so "0" really is behind it.
    await pull(store, opened, [host])
    const summary = await pull(store, opened, [lying])
    expect(summary.hosts[0].stopped).toMatchObject({ reason: 'page_mismatch' })
    expect(summary.hosts[0].cursorAfter).toBe(1)
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].lastCursor).toBe(1)
  })
})

describe('the shared capacity gate applies to mirrors', () => {
  it('drops a refused noise row but still accepts a crash, exactly like a local writer', async () => {
    const { opened } = openStore()
    // One row allowed: fill it locally, then the mirror must meet the same gate.
    const limited = createIncidentStore({
      db: opened.db,
      fileSizeBytes: opened.fileSizeBytes,
      limits: { maxRows: 1, maxBytes: 500 * 1024 * 1024 }
    })
    limited.insertIncident(record({ id: 'inc_local_fill', sourceId: 'fill', class: 'crash' }))

    const host = fakeHost('host-a', originRecords('host-a', 2))
    const summary = await pull(limited, opened, [host])

    expect(summary.hosts[0]).toMatchObject({ inserted: 1, dropped: 1, stopped: null })
    expect(limited.listIncidents().total).toBe(2)
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].droppedRows).toBe(1)
    // A dropped mirror line advanced the cursor: it will not be retried, and it is counted durably.
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].lastCursor).toBe(2)
  })
})

describe('the read surface', () => {
  it('states "no origin registered" as a scope statement, not as a clean answer', () => {
    const { opened } = openStore()
    const text = formatIncidentMirrorCoverage(readIncidentMirrorCoverage(opened.db), {
      path: opened.path,
      readAt: NOW
    })
    expect(text).toContain('No origin host is registered with this store.')
    expect(text).toContain('NOT evidence')
    expect(text).toContain('that no incidents happened on any other host')
  })

  it('prints a behind mirror with its retained unsynced count and the failing origin', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 3))
    await pull(store, opened, [host], { maxLinesPerHost: 1 })
    host.failWith = new Error('relay closed')
    await pull(store, opened, [host])

    const coverage = readIncidentMirrorCoverage(opened.db)
    const text = formatIncidentMirrorCoverage(coverage, { path: opened.path, readAt: NOW })
    expect(text).toContain('Capture: mirrored  hosts=1  unsynced=2')
    expect(text).toContain('host-a  mirrored  cursor=1  unsynced=2')
    expect(text).toContain('last_error=feed_error: Error: relay closed')
    expect(text).toContain('WARNING: the mirror is behind')

    // JSON is the machine-readable half; it must carry the same numbers and the path it read.
    const json = formatIncidentMirrorJson(coverage, { path: opened.path, readAt: NOW })
    expect(json).toMatchObject({
      path: opened.path,
      readAt: NOW,
      mirror: { capture: 'mirrored', unsynced: 2, unreachable: 1 }
    })
  })

  it('prints origin-declared skips and provenance corruption instead of hiding them', async () => {
    const { store, opened } = openStore()
    const lines = shadowLines(originRecords('host-a', 1))
    await pull(store, opened, [
      {
        hostId: 'host-a',
        read: () => ({
          lines,
          nextSeq: 5,
          hasMore: false,
          pending: 0,
          skipped: { reason: 'origin_capacity_drop', count: 4 }
        })
      }
    ])
    // Plant a second provenance row for the same fact key on a table without the UNIQUE constraint.
    opened.db.exec('ALTER TABLE incident_mirror_rows RENAME TO incident_mirror_rows_old')
    opened.db.exec(`CREATE TABLE incident_mirror_rows (
      incident_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL, source_id TEXT NOT NULL, facet TEXT NOT NULL,
      host_id TEXT NOT NULL, origin_seq INTEGER NOT NULL, pulled_at INTEGER NOT NULL)`)
    opened.db.exec('DROP TABLE incident_mirror_rows_old')
    opened.db
      .prepare(
        `INSERT INTO incident_mirror_rows
           (incident_id, source_kind, source_id, facet, host_id, origin_seq, pulled_at)
         VALUES ('inc_x1','pty_exit','dup','exit','host-a',1,?), ('inc_x2','pty_exit','dup','exit','host-a',1,?)`
      )
      .run(NOW, NOW)

    const coverage = readIncidentMirrorCoverage(opened.db)
    const text = formatIncidentMirrorCoverage(coverage, { path: opened.path, readAt: NOW })
    expect(text).toContain('skipped=4')
    expect(text).toContain('origin_capacity_drop')
    expect(text).toContain('more than one provenance row')
  })

  it('never renders a never-read origin as caught up', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 1))
    host.failWith = new Error('no route to host')
    await pull(store, opened, [host])
    const text = formatIncidentMirrorCoverage(readIncidentMirrorCoverage(opened.db), {
      path: opened.path,
      readAt: NOW
    })
    expect(text).toContain('Capture: not_probed')
    expect(text).toContain('unsynced=unknown')
    expect(text).toContain('has never been read')
    expect(text).not.toContain('unsynced=0')
  })
})

describe('the feed registry', () => {
  it('holds one feed per host and is resettable for tests', () => {
    for (const feed of [fakeHost('host-a', []), fakeHost('host-b', [])]) {
      registerMirrorFeed(feed)
    }
    expect(listMirrorFeeds().map((feed) => feed.hostId)).toEqual(['host-a', 'host-b'])
    __resetMirrorFeedsForTests()
    expect(listMirrorFeeds()).toEqual([])
  })

  it('reports ran=false when nothing is registered, without touching the store', async () => {
    const { store, opened } = openStore()
    const summary = await pull(store, opened, [])
    expect(summary).toMatchObject({ ran: false, hosts: [], inserted: 0 })
    expect(readIncidentMirrorCoverage(opened.db).capture).toBe('unsupported')
  })
})

describe('startup wiring', () => {
  it('does nothing at all when no feed is registered, not even opening the store', async () => {
    const result = await syncIncidentMirrorAtStartup({ userDataPath: '/tmp/never-read' })
    expect(result).toEqual({ ran: false, reason: 'no_feeds' })
  })

  it('pulls every registered feed once per process, never twice', async () => {
    const { store, opened } = openStore()
    __configureIncidentStoreForTests(store, opened.db)
    registerMirrorFeed(fakeHost('host-a', originRecords('host-a', 2)))

    const first = await syncIncidentMirrorAtStartup({ userDataPath: '/tmp/never-read' })
    expect(first.ran).toBe(true)
    expect(first.summary?.inserted).toBe(2)
    expect(store.listIncidents().total).toBe(2)

    // The startup guard is once-per-process; a reconnect calls `syncIncidentMirror` directly.
    const second = await syncIncidentMirrorAtStartup({ userDataPath: '/tmp/never-read' })
    expect(second).toEqual({ ran: false, reason: 'already_synced' })
  })
})

describe('atomic mirrored insert (review C1)', () => {
  it('rolls the incident row back when the provenance write fails, so no half-write exists to prune', async () => {
    const { store, opened } = openStore()
    // Force the provenance insert to fail without touching anything else: a trigger that aborts.
    opened.db.exec(
      `CREATE TRIGGER test_block_provenance BEFORE INSERT ON incident_mirror_rows
       BEGIN SELECT RAISE(ABORT, 'blocked_for_test'); END;`
    )
    const host = fakeHost('host-a', originRecords('host-a', 1))

    const failed = await pull(store, opened, [host])
    expect(failed.hosts[0].inserted).toBe(0)
    expect(failed.hosts[0].stopped).toMatchObject({ reason: 'store_refused' })
    expect(failed.hosts[0].stopped?.detail).toContain('provenance_failed')
    // Atomicity: the incident row was rolled back, so there is nothing unprovenanced to prune and the
    // prune-before-heal window (trace C1) cannot even open.
    expect(store.listIncidents().total).toBe(0)
    expect(readIncidentMirrorCoverage(opened.db).hosts[0].lastCursor).toBe(0)
    // "Prune before heal" has nothing to delete: the tombstone question is moot, not lost.
    expect(store.pruneIncidents({ dryRun: false, now: NOW }).deleted).toBe(0)

    // Remove the fault: the same line is retried (cursor never advanced) and lands with provenance.
    opened.db.exec('DROP TRIGGER test_block_provenance')
    const retried = await pull(store, opened, [host])
    expect(retried.hosts[0].inserted).toBe(1)
    expect(store.listIncidents().total).toBe(1)
    expect(readMirrorProvenance(opened.db, 'inc_host-a_1')).not.toBeNull()
  })

  it('still refuses to resurrect a fact pruned after it was mirrored (tombstone holds)', async () => {
    const { store, opened } = openStore()
    const old = originRecords('host-a', 1)[0]
    old.record.createdAt = NOW - 400 * DAY
    const host = fakeHost('host-a', [old])
    await pull(store, opened, [host])
    store.appendDecision({
      incidentId: 'inc_host-a_1',
      toStatus: 'invalid',
      actor: 'operator',
      reason: 'not a real failure'
    })
    expect(store.pruneIncidents({ dryRun: false, now: NOW }).deleted).toBe(1)

    opened.db.prepare('UPDATE incident_mirror_links SET last_cursor = 0').run()
    const again = await pull(store, opened, [host])
    expect(again.hosts[0]).toMatchObject({ inserted: 0, pruned: 1 })
    expect(store.listIncidents().total).toBe(0)
    expect(readIncidentMirrorCoverage(opened.db).pruned).toBe(1)
  })
})

describe('provenance key uniqueness (review C2)', () => {
  it('fails closed when one fact key has two provenance rows instead of picking one', async () => {
    const { store, opened } = openStore()
    const host = fakeHost('host-a', originRecords('host-a', 1))
    // A store written before the UNIQUE constraint (or edited outside Orca): rebuild the provenance
    // table without it and plant the ambiguity the constraint now forbids.
    opened.db.exec('ALTER TABLE incident_mirror_rows RENAME TO incident_mirror_rows_old')
    opened.db.exec(`CREATE TABLE incident_mirror_rows (
      incident_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      facet       TEXT NOT NULL,
      host_id     TEXT NOT NULL,
      origin_seq  INTEGER NOT NULL,
      pulled_at   INTEGER NOT NULL
    )`)
    opened.db.exec('DROP TABLE incident_mirror_rows_old')
    const insert = opened.db.prepare(
      `INSERT INTO incident_mirror_rows
         (incident_id, source_kind, source_id, facet, host_id, origin_seq, pulled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const origin = originRecords('host-a', 1)[0].record
    insert.run('inc_dup_1', origin.sourceKind, origin.sourceId, origin.facet, 'host-a', 1, NOW)
    insert.run('inc_dup_2', origin.sourceKind, origin.sourceId, origin.facet, 'host-a', 1, NOW)

    const summary = await pull(store, opened, [host])

    expect(summary.hosts[0].inserted).toBe(0)
    expect(summary.hosts[0].stopped).toMatchObject({ reason: 'store_refused' })
    expect(summary.hosts[0].stopped?.detail).toContain('provenance_conflict')
    expect(summary.hosts[0].cursorAfter).toBe(0)
    expect(store.listIncidents().total).toBe(0)
    // The conflict is part of the read model, not only a log line.
    expect(readIncidentMirrorCoverage(opened.db).provenanceConflicts).toBe(1)
  })
})

describe('nextSeq jumps need an origin-declared reason (review C3)', () => {
  function gapFeed(options: { skipped?: { reason: string; count?: number } | null }) {
    const lines = shadowLines(originRecords('host-a', 1))
    return {
      hostId: 'host-a',
      read: (): MirrorPage => ({
        lines,
        nextSeq: 5,
        hasMore: false,
        pending: 0,
        skipped: options.skipped ?? null
      })
    } satisfies MirrorFeed
  }

  it('stops instead of skipping an unexplained range', async () => {
    const { store, opened } = openStore()
    const summary = await pull(store, opened, [gapFeed({ skipped: null })])

    expect(summary.hosts[0].inserted).toBe(1)
    expect(summary.hosts[0].stopped).toMatchObject({ reason: 'page_mismatch' })
    expect(summary.hosts[0].stopped?.detail).toContain('unexplained_gap_1_to_5')
    // The delivered row is kept; the cursor does NOT jump over the unexplained range.
    expect(summary.hosts[0].cursorAfter).toBe(1)
    const coverage = readIncidentMirrorCoverage(opened.db)
    expect(coverage.hosts[0].lastCursor).toBe(1)
    expect(coverage.skippedRows).toBe(0)
    expect(coverage.lastError).toContain('unexplained_gap')
    expect(store.listIncidents().total).toBe(1)
  })

  it('accepts the jump when the origin declares it, and counts it durably', async () => {
    const { store, opened } = openStore()
    const summary = await pull(
      store,
      opened,
      [gapFeed({ skipped: { reason: 'origin_capacity_drop', count: 4 } })]
    )

    expect(summary.hosts[0].stopped).toBeNull()
    expect(summary.hosts[0].cursorAfter).toBe(5)
    expect(summary.hosts[0]).toMatchObject({ skippedRows: 4, skippedRanges: 1 })
    const coverage = readIncidentMirrorCoverage(opened.db)
    expect(coverage.hosts[0].lastCursor).toBe(5)
    expect(coverage.skippedRows).toBe(4)
    expect(coverage.hosts[0].skippedRanges).toBe(1)
    expect(coverage.hosts[0].lastSkippedReason).toBe('origin_capacity_drop')
  })

  it('rejects a "skipped" explanation with no reason', async () => {
    const { store, opened } = openStore()
    const summary = await pull(
      store,
      opened,
      [gapFeed({ skipped: { reason: '   ', count: 4 } })]
    )
    expect(summary.hosts[0].stopped).toMatchObject({
      reason: 'page_mismatch',
      detail: 'skipped_range_without_reason'
    })
    // Nothing from the page lands: an explanation we cannot read is not an explanation.
    expect(summary.hosts[0].inserted).toBe(0)
    expect(summary.hosts[0].cursorAfter).toBe(0)
  })
})
