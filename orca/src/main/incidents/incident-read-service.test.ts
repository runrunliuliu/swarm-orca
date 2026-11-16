/**
 * The read service is the only place a viewer touches the store (A-fix, 2026-11-16).
 *
 * The regression this pins, in one line: opening the panel used to create `<userData>/incidents/` and
 * migrate the schema on a host that had never written an incident. Every test below asserts a *missing*
 * side effect as loudly as it asserts the answer.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import { incidentDetailFromView, openIncidentReadService, openIncidentReadStore } from './incident-read-service'
import type { IncidentRecord } from './incident-types'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { initDataPath } from '../persistence/loading-store/user-data-path'

const directories: string[] = []
let userData: string

function appEnvironmentAt(path: string): AppEnvironment {
  return {
    getPath: (name: string) => {
      if (name !== 'userData') {
        throw new Error(`unexpected getPath(${name})`)
      }
      return path
    }
  } as unknown as AppEnvironment
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: 'inc_read_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'a'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: ['transcript pointer not collected'] },
    summary: 'Agent process killed by signal 9',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function seedStore(records: IncidentRecord[] = [record()]): void {
  const opened = openIncidentsDatabase(join(userData, 'incidents', 'incidents.db'))
  try {
    const store = createIncidentStore({ db: opened.db })
    for (const item of records) {
      store.insertIncident(item)
    }
  } finally {
    opened.db.close()
  }
}

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-read-'))
  directories.push(directory)
  userData = directory
  setAppEnvironment(appEnvironmentAt(directory))
  // Why: the canonical userData path is captured once (the runtime calls initDataPath at the right
  // moment), so each test must re-point it or it keeps reading the previous temporary directory.
  initDataPath()
})

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('a host that never wrote an incident', () => {
  it('answers store-not-created and creates nothing on disk', () => {
    const reader = openIncidentReadService()
    try {
      const snapshot = reader.snapshot(undefined, { kind: 'local' })
      const counts = reader.counts(undefined, { kind: 'local' })

      expect(snapshot.availability).toBe('supported')
      if (snapshot.availability !== 'supported') {
        throw new Error('unreachable')
      }
      expect(snapshot.value.availability).toBe('store-not-created')
      expect(snapshot.value.incidents).toEqual([])
      expect(snapshot.value.source).toEqual({ kind: 'local' })
      // Nothing was lost, so the badge must not draw a lower-bound marker.
      expect(snapshot.value.coverage.capacity.rows).toBe(0)

      expect(counts.availability).toBe('supported')
      if (counts.availability !== 'supported') {
        throw new Error('unreachable')
      }
      expect(counts.value.availability).toBe('store-not-created')
      expect(counts.value.untriaged).toBe(0)
      expect(counts.value.coverage.gap).toBe(false)
    } finally {
      reader.close()
    }

    // The whole point: a viewer must not make the database appear.
    expect(readdirSync(userData)).toEqual([])
  })

  it('reports a detail as store-not-created rather than a fabricated row', () => {
    const reader = openIncidentReadService()
    try {
      expect(reader.detail('inc_missing', { kind: 'local' }).availability).toBe('store-not-created')
    } finally {
      reader.close()
    }
    expect(readdirSync(userData)).toEqual([])
  })
})

describe('a host with a store', () => {
  it('projects the rows, the counts and the source it was read with', () => {
    seedStore([
      record(),
      record({ id: 'inc_read_2', status: 'closed', sourceId: 'ptyinc-2', fingerprint: 'b'.repeat(64) })
    ])

    const reader = openIncidentReadService()
    try {
      const source = { kind: 'environment' as const, environmentId: 'env-1' }
      const snapshot = reader.snapshot(undefined, source)
      if (snapshot.availability !== 'supported') {
        throw new Error('expected a supported snapshot')
      }
      expect(snapshot.value.availability).toBe('supported')
      expect(snapshot.value.total).toBe(2)
      expect(snapshot.value.source).toEqual(source)
      expect(snapshot.value.incidents.map((item) => item.id).sort()).toEqual([
        'inc_read_1',
        'inc_read_2'
      ])

      // The filter still means what the panel's "untriaged" tab means.
      const untriaged = reader.snapshot({ status: 'untriaged' }, source)
      if (untriaged.availability !== 'supported') {
        throw new Error('expected a supported snapshot')
      }
      expect(untriaged.value.total).toBe(1)

      const counts = reader.counts(undefined, source)
      if (counts.availability !== 'supported') {
        throw new Error('expected supported counts')
      }
      expect(counts.value.total).toBe(2)
      expect(counts.value.source).toEqual(source)
    } finally {
      reader.close()
    }
  })

  it('reads without creating a -wal/-shm pair or rewriting the file', () => {
    seedStore()
    const before = readdirSync(join(userData, 'incidents')).sort()

    const handle = openIncidentReadStore()
    if (handle.availability !== 'supported') {
      throw new Error('expected a supported handle')
    }
    expect(handle.store.listIncidents({}).total).toBe(1)
    handle.close()

    expect(readdirSync(join(userData, 'incidents')).sort()).toEqual(before)
  })

  it('turns an unknown filter into an unavailable answer, never an empty list', () => {
    seedStore()
    const reader = openIncidentReadService()
    try {
      const outcome = reader.snapshot(
        { status: 'not_a_status' as never },
        { kind: 'local' }
      )
      expect(outcome.availability).toBe('unavailable')
    } finally {
      reader.close()
    }
  })

  it('keeps the detail projection tied to the source that asked', () => {
    seedStore()
    const handle = openIncidentReadStore()
    if (handle.availability !== 'supported') {
      throw new Error('expected a supported handle')
    }
    try {
      const view = handle.store.getIncident('inc_read_1')
      expect(view).not.toBeNull()
      const local = incidentDetailFromView(view!, { kind: 'local' })
      const remote = incidentDetailFromView(view!, { kind: 'environment', environmentId: 'env-9' })
      expect(local.source).toEqual({ kind: 'local' })
      expect(remote.source).toEqual({ kind: 'environment', environmentId: 'env-9' })
      expect(remote.decisions).toEqual(local.decisions)
    } finally {
      handle.close()
    }
  })

  it('reports unreadable bytes as unavailable instead of pretending the store is empty', () => {
    seedStore()
    const path = join(userData, 'incidents', 'incidents.db')
    writeFileSync(path, 'not a database')

    const reader = openIncidentReadService()
    try {
      const outcome = reader.snapshot(undefined, { kind: 'local' })
      expect(outcome.availability).toBe('unavailable')
    } finally {
      reader.close()
    }
  })
})
