/**
 * Store behaviour §6 and §11.5 promise: idempotent inserts, append-only decisions, a capacity stop
 * that spares crashes, prune that only ever touches triaged-away rows, and redaction before landing.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import {
  DEFAULT_INCIDENT_RETENTION_DAYS,
  createIncidentStore,
  type IncidentStore
} from './incident-store'
import type { IncidentClass, IncidentRecord } from './incident-types'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

const temporaryDirectories: string[] = []
const openDatabases: OpenIncidentsDatabase[] = []

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incidents-store-'))
  temporaryDirectories.push(directory)
  return join(directory, 'incidents.db')
}

function openPair(path = databasePath()): { opened: OpenIncidentsDatabase; store: IncidentStore } {
  const opened = openIncidentsDatabase(path)
  openDatabases.push(opened)
  return {
    opened,
    store: createIncidentStore({
      db: opened.db,
      fileSizeBytes: opened.fileSizeBytes,
      now: () => NOW
    })
  }
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  const second = overrides.sourceId !== undefined
  return {
    id: second ? 'inc_2' : 'inc_1',
    sourceKind: 'pty_exit',
    sourceId: 'inc-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'inc-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: ['unknown: transcript pointer not collected'] },
    summary: 'agent killed by signal 9',
    createdAt: NOW,
    ...overrides
  }
}

afterEach(() => {
  for (const opened of openDatabases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('insertIncident idempotency', () => {
  it('writes one row for a repeated key and reports the existing id', () => {
    const { store } = openPair()
    const first = store.insertIncident(record())
    const second = store.insertIncident(record({ id: 'inc_other' }))
    expect(first).toMatchObject({ outcome: 'inserted', id: 'inc_1' })
    expect(second).toMatchObject({ outcome: 'duplicate', id: 'inc_1' })
    expect(store.countIncidents()).toBe(1)
  })

  it('keeps a second genuine failure of the same entity: the epoch is part of the key', () => {
    const { store } = openPair()
    store.insertIncident(record())
    const respawn = store.insertIncident(
      record({ id: 'inc_2', sourceId: 'inc-2', ptyIncarnationId: 'inc-2' })
    )
    expect(respawn.outcome).toBe('inserted')
    expect(store.countIncidents()).toBe(2)
  })

  it('is idempotent across two connections (concurrent writers)', () => {
    const path = databasePath()
    const first = openPair(path)
    const second = openPair(path)
    const results = [
      first.store.insertIncident(record()),
      second.store.insertIncident(record({ id: 'inc_1_again' }))
    ]
    expect(results.filter((result) => result.outcome === 'inserted')).toHaveLength(1)
    expect(results.filter((result) => result.outcome === 'duplicate')).toHaveLength(1)
    expect(first.store.countIncidents()).toBe(1)
    expect(second.store.countIncidents()).toBe(1)
  })

  it('rejects a record whose class or status is outside the closed vocabulary', () => {
    const { store } = openPair()
    const result = store.insertIncident(
      record({ class: 'not_a_class' as IncidentClass })
    )
    expect(result.outcome).toBe('invalid_record')
    expect(store.countIncidents()).toBe(0)
  })

  it('redacts the summary before it lands', () => {
    const { store } = openPair()
    store.insertIncident(
      record({
        summary: 'failed with key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'
      })
    )
    const view = store.getIncident('inc_1')
    expect(view?.summary).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz')
  })
})

describe('appendDecision', () => {
  it('appends and projects the effective status without editing the row', () => {
    const { store } = openPair()
    store.insertIncident(record())
    const result = store.appendDecision({
      incidentId: 'inc_1',
      toStatus: 'watch',
      actor: 'alice',
      reason: 'waiting for a second occurrence',
      createdAt: NOW + 1
    })
    expect(result.outcome).toBe('appended')
    expect(result).toMatchObject({ fromStatus: 'untriaged', toStatus: 'watch' })
    const view = store.getIncident('inc_1')
    expect(view?.status).toBe('untriaged')
    expect(view?.effectiveStatus).toBe('watch')
    expect(view?.decisions).toHaveLength(1)
    expect(view?.decisions[0].actor).toBe('alice')
  })

  it('rejects a move the transition table forbids, and an unchanged status', () => {
    const { store } = openPair()
    store.insertIncident(record())
    store.appendDecision({ incidentId: 'inc_1', toStatus: 'invalid', actor: 'a', reason: 'no bug' })
    expect(
      store.appendDecision({ incidentId: 'inc_1', toStatus: 'confirmed', actor: 'a', reason: 'reopen' })
    ).toMatchObject({ outcome: 'invalid_transition', fromStatus: 'invalid' })
    expect(
      store.appendDecision({ incidentId: 'inc_1', toStatus: 'invalid', actor: 'a', reason: 'again' })
    ).toMatchObject({ outcome: 'status_unchanged' })
  })

  it('requires an actor and a reason, and reports an unknown incident', () => {
    const { store } = openPair()
    store.insertIncident(record())
    expect(
      store.appendDecision({ incidentId: 'inc_1', toStatus: 'watch', actor: '  ', reason: 'x' })
    ).toMatchObject({ outcome: 'actor_required' })
    expect(
      store.appendDecision({ incidentId: 'inc_1', toStatus: 'watch', actor: 'a', reason: '  ' })
    ).toMatchObject({ outcome: 'reason_required' })
    expect(
      store.appendDecision({ incidentId: 'nope', toStatus: 'watch', actor: 'a', reason: 'x' })
    ).toMatchObject({ outcome: 'not_found' })
  })
})

describe('capacity (§11.5)', () => {
  it('stops new non-crash rows at the row limit and latches the coverage flag', () => {
    const opened = openIncidentsDatabase(databasePath())
    openDatabases.push(opened)
    const store = createIncidentStore({
      db: opened.db,
      limits: { maxRows: 1 },
      now: () => NOW
    })
    expect(store.insertIncident(record()).outcome).toBe('inserted')
    const refused = store.insertIncident(
      record({
        id: 'inc_2',
        sourceId: 'inc-2',
        class: 'no_progress',
        status: 'untriaged'
      })
    )
    expect(refused).toMatchObject({ outcome: 'capacity_limited', limitedBy: 'rows' })
    expect(store.coverage()).toMatchObject({ capacityLatchSet: true, currentlyLimited: true })
    expect(store.countIncidents()).toBe(1)
  })

  it('still accepts a crash row at the limit', () => {
    const opened = openIncidentsDatabase(databasePath())
    openDatabases.push(opened)
    const store = createIncidentStore({ db: opened.db, limits: { maxRows: 1 }, now: () => NOW })
    store.insertIncident(record({ class: 'no_progress' }))
    const crash = store.insertIncident(record({ id: 'inc_2', sourceId: 'inc-2' }))
    expect(crash.outcome).toBe('inserted')
  })

  it('separates "has refused before" from "is refusing now" across a prune (C3)', () => {
    const opened = openIncidentsDatabase(databasePath())
    openDatabases.push(opened)
    const store = createIncidentStore({ db: opened.db, limits: { maxRows: 1 }, now: () => NOW })
    const old = NOW - (DEFAULT_INCIDENT_RETENTION_DAYS + 1) * DAY

    // One old, triaged-away row occupies the only slot.
    store.insertIncident(record({ id: 'inc_old', sourceId: 'old', createdAt: old }))
    store.appendDecision({ incidentId: 'inc_old', toStatus: 'invalid', actor: 'a', reason: 'r' })
    expect(store.coverage()).toMatchObject({ capacityLatchSet: false, currentlyLimited: true })

    // A noise row is refused, which sets the latch.
    expect(store.insertIncident(record({ id: 'inc_noise', sourceId: 'noise', class: 'no_progress' })).outcome).toBe(
      'capacity_limited'
    )
    expect(store.coverage()).toMatchObject({ capacityLatchSet: true, currentlyLimited: true })

    // Pruning the old row drops below the limit: the refusal is history, not the present.
    expect(store.pruneIncidents({ dryRun: false, now: NOW }).deleted).toBe(1)
    expect(store.coverage()).toMatchObject({ capacityLatchSet: true, currentlyLimited: false })
    expect(
      store.insertIncident(record({ id: 'inc_noise_2', sourceId: 'noise-2', class: 'no_progress' })).outcome
    ).toBe('inserted')
  })

  it('stops on the byte limit too', () => {
    const opened = openIncidentsDatabase(databasePath())
    openDatabases.push(opened)
    let bytes = 0
    const store = createIncidentStore({
      db: opened.db,
      fileSizeBytes: () => bytes,
      limits: { maxBytes: 1000 },
      now: () => NOW
    })
    bytes = 2000
    expect(
      store.insertIncident(record({ class: 'tool_error' })).outcome
    ).toBe('capacity_limited')
    expect(store.coverage().capacity.bytes).toBe(2000)
  })
})

describe('prune (§11.5)', () => {
  function seed(store: IncidentStore): void {
    const old = NOW - (DEFAULT_INCIDENT_RETENTION_DAYS + 1) * DAY
    store.insertIncident(record({ id: 'inc_old_invalid', sourceId: 'a', createdAt: old }))
    store.insertIncident(record({ id: 'inc_old_watch', sourceId: 'b', createdAt: old }))
    store.insertIncident(record({ id: 'inc_new_invalid', sourceId: 'c', createdAt: NOW }))
    store.appendDecision({ incidentId: 'inc_old_invalid', toStatus: 'invalid', actor: 'a', reason: 'r' })
    store.appendDecision({ incidentId: 'inc_old_watch', toStatus: 'watch', actor: 'a', reason: 'r' })
    store.appendDecision({ incidentId: 'inc_new_invalid', toStatus: 'invalid', actor: 'a', reason: 'r' })
  }

  it('reports candidates without deleting on a dry run', () => {
    const { store } = openPair()
    seed(store)
    const result = store.pruneIncidents({ dryRun: true, now: NOW })
    expect(result.candidates).toBe(1)
    expect(result.deleted).toBe(0)
    expect(result.candidateIds).toEqual(['inc_old_invalid'])
    expect(result.candidateIdsTruncated).toBe(false)
    expect(result.deletedIds).toEqual([])
    expect(store.countIncidents()).toBe(3)
  })

  it('reports the ids it deleted, so retained decisions stay locatable (C5)', () => {
    const { store, opened } = openPair()
    seed(store)
    const result = store.pruneIncidents({ dryRun: false, now: NOW })
    expect(result.deletedIds).toEqual(['inc_old_invalid'])
    expect(result.deletedIdsTruncated).toBe(false)
    expect(store.getIncident('inc_old_invalid')).toBeNull()
    // The decision that explains the removal survives with no incident row behind it — which is
    // exactly why the reported id is the only handle back to it.
    const kept = opened.db
      .prepare('SELECT COUNT(*) AS n FROM incident_decisions WHERE incident_id = ?')
      .get('inc_old_invalid')
    expect(Number(kept?.n)).toBe(1)
  })

  it('caps the reported ids and says they were truncated', () => {
    const { store } = openPair()
    const old = NOW - (DEFAULT_INCIDENT_RETENTION_DAYS + 1) * DAY
    for (const id of ['a', 'b']) {
      store.insertIncident(record({ id: `inc_${id}`, sourceId: id, createdAt: old }))
      store.appendDecision({ incidentId: `inc_${id}`, toStatus: 'invalid', actor: 'x', reason: 'r' })
    }
    const result = store.pruneIncidents({ dryRun: true, now: NOW, idReportLimit: 1 })
    expect(result.candidates).toBe(2)
    expect(result.candidateIds).toHaveLength(1)
    expect(result.candidateIdsTruncated).toBe(true)
  })

  it('deletes only old invalid/duplicate/closed rows and retains decisions', () => {
    const { store } = openPair()
    seed(store)
    const result = store.pruneIncidents({ dryRun: false, now: NOW })
    expect(result).toMatchObject({ candidates: 1, deleted: 1, byStatus: { invalid: 1 } })
    expect(store.getIncident('inc_old_invalid')).toBeNull()
    expect(store.getIncident('inc_old_watch')).not.toBeNull()
    expect(store.getIncident('inc_new_invalid')).not.toBeNull()
    // The audit trail outlives the row it explains.
    const decisions = store
      .listIncidents({ limit: 10 })
      .incidents.map((incident) => incident.decisionCount)
    expect(decisions).toContain(1)
  })

  it('never deletes an untriaged row, however old', () => {
    const { store } = openPair()
    store.insertIncident(record({ createdAt: NOW - 400 * DAY }))
    expect(store.pruneIncidents({ dryRun: false, now: NOW }).deleted).toBe(0)
    expect(store.countIncidents()).toBe(1)
  })
})

describe('listIncidents', () => {
  it('filters, counts the whole match set, and always reports coverage', () => {
    const { store } = openPair()
    store.insertIncident(record({ id: 'inc_1', sourceId: 'a', class: 'crash' }))
    store.insertIncident(
      record({ id: 'inc_2', sourceId: 'b', class: 'tool_error', createdAt: NOW + 1 })
    )
    const all = store.listIncidents({ limit: 1 })
    expect(all.incidents).toHaveLength(1)
    expect(all.total).toBe(2)
    expect(all.coverage.remoteIncidentCapture).toBe('unsupported')
    expect(store.listIncidents({ class: 'crash' }).total).toBe(1)
    expect(store.listIncidents({ status: 'untriaged' }).total).toBe(2)
    store.appendDecision({ incidentId: 'inc_1', toStatus: 'watch', actor: 'a', reason: 'r' })
    expect(store.listIncidents({ status: 'watch' }).incidents[0].id).toBe('inc_1')
  })
})
