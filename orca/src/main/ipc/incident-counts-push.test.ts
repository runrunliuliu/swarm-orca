/**
 * The counts push (§12, M7-A): one notification per settled burst, and a store write is the trigger.
 *
 * Why this is pinned rather than left to the coalescer's own tests: a PTY teardown can insert several
 * rows back to back and a replay inserts one per hint line, so "one send per change" would put dozens of
 * IPC sends on the teardown path. The number of notifications is a product decision here, not an
 * optimization detail.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentCountsDto } from '../../shared/incident-api-types'
import { onIncidentStoreChange, type IncidentStoreChange } from '../incidents/incident-store-changes'
import type { IncidentRecord } from '../incidents/incident-types'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../incidents/incident-writer'
import {
  INCIDENT_COUNTS_FLUSH_MS,
  __resetIncidentCountsPushForTests,
  startIncidentCountsPush
} from './incident-counts-push'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []
const DAY_MS = 24 * 60 * 60 * 1000

function realStore(): { store: IncidentStore; opened: OpenIncidentsDatabase } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-push-'))
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
    id: 'inc_push_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-push-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-push-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'unknown', reason: 'stop_unverified' },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: 'stop never confirmed',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  __resetIncidentCountsPushForTests()
  __resetIncidentWriterForTests()
  vi.useRealTimers()
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

describe('incident counts push', () => {
  it('coalesces three changes into one notification carrying the newest counts', async () => {
    const { store, opened } = realStore()
    __configureIncidentStoreForTests(store, opened.db)
    const sends: IncidentCountsDto[] = []
    startIncidentCountsPush((counts) => sends.push(counts))

    store.insertIncident(record({ id: 'inc_1', sourceId: 's1' }))
    store.insertIncident(record({ id: 'inc_2', sourceId: 's2' }))
    store.insertIncident(record({ id: 'inc_3', sourceId: 's3' }))
    // Nothing has settled yet: the whole point is that three writes are not three sends.
    expect(sends).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends).toHaveLength(1)
    // The read happens inside the emit, so the payload is the state after all three inserts.
    expect(sends[0]).toMatchObject({ untriaged: 3, total: 3 })
    expect(sends[0].byClass.crash).toBe(3)

    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS * 4)
    expect(sends).toHaveLength(1)
  })

  it('sends again after a second burst has settled', async () => {
    const { store, opened } = realStore()
    __configureIncidentStoreForTests(store, opened.db)
    const sends: IncidentCountsDto[] = []
    startIncidentCountsPush((counts) => sends.push(counts))

    store.insertIncident(record({ id: 'inc_1', sourceId: 's1' }))
    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends.map((counts) => counts.untriaged)).toEqual([1])

    store.insertIncident(record({ id: 'inc_2', sourceId: 's2' }))
    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends.map((counts) => counts.untriaged)).toEqual([1, 2])
  })

  it('treats a duplicate insert as no change at all', async () => {
    const { store, opened } = realStore()
    __configureIncidentStoreForTests(store, opened.db)
    const sends: IncidentCountsDto[] = []
    startIncidentCountsPush((counts) => sends.push(counts))

    store.insertIncident(record({ id: 'inc_1', sourceId: 's1' }))
    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends).toHaveLength(1)

    // Same (source_kind, source_id, facet): the insert was refused in place, so nothing to announce.
    expect(store.insertIncident(record({ id: 'inc_1b', sourceId: 's1' })).outcome).toBe('duplicate')
    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends).toHaveLength(1)
  })

  it('replaces its subscription when started twice instead of doubling every notification', async () => {
    const { store, opened } = realStore()
    __configureIncidentStoreForTests(store, opened.db)
    const sends: IncidentCountsDto[] = []
    startIncidentCountsPush((counts) => sends.push(counts))
    startIncidentCountsPush((counts) => sends.push(counts))

    store.insertIncident(record())
    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends).toHaveLength(1)
  })

  it('stops sending once stopped', async () => {
    const { store, opened } = realStore()
    __configureIncidentStoreForTests(store, opened.db)
    const sends: IncidentCountsDto[] = []
    startIncidentCountsPush((counts) => sends.push(counts)).stop()

    store.insertIncident(record())
    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends).toEqual([])
  })

  it('says nothing when the store was never opened, rather than reporting zero incidents', async () => {
    // A write still happened (the store object exists), but the host has no *opened* runtime store, so a
    // payload would have to invent "0 untriaged" for an unreadable store. It sends nothing instead.
    const { store } = realStore()
    __configureIncidentStoreForTests(null)
    const sends: IncidentCountsDto[] = []
    startIncidentCountsPush((counts) => sends.push(counts))
    expect(store.insertIncident(record()).outcome).toBe('inserted')
    await vi.advanceTimersByTimeAsync(INCIDENT_COUNTS_FLUSH_MS)
    expect(sends).toEqual([])
  })
})

describe('store change signal', () => {
  it('fires for an insert, a decision and a prune, and not for a dry run', () => {
    const { store } = realStore()
    const seen: IncidentStoreChange[] = []
    const off = onIncidentStoreChange((change) => seen.push(change))
    try {
      store.insertIncident(record({ createdAt: 1_000 }))
      store.appendDecision({ incidentId: 'inc_push_1', toStatus: 'invalid', actor: 'a', reason: 'r' })
      store.pruneIncidents({ dryRun: true, olderThanDays: 1, now: 100 * DAY_MS })
      expect(seen.map((change) => change.kind)).toEqual(['insert', 'decision'])

      const pruned = store.pruneIncidents({
        dryRun: false,
        olderThanDays: 1,
        now: 100 * DAY_MS
      })
      expect(pruned.deleted).toBe(1)
      expect(seen.map((change) => change.kind)).toEqual(['insert', 'decision', 'prune'])
      expect(seen.at(-1)?.rows).toBe(1)
    } finally {
      off()
    }
  })

  it('survives a listener that throws, so a UI bug cannot fail the write', () => {
    const { store } = realStore()
    const off = onIncidentStoreChange(() => {
      throw new Error('bad subscriber')
    })
    try {
      expect(store.insertIncident(record()).outcome).toBe('inserted')
    } finally {
      off()
    }
    expect(store.countIncidents()).toBe(1)
  })
})
