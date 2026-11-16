/**
 * The count read model (§12, M7-A): what the activity-bar badge draws, against a real SQLite file.
 *
 * The assertions are about *agreement*, not about an implementation: the total must equal the sum of
 * the per-class breakdown, a triaged row must stop being untriaged, a pruned row must leave both
 * numbers, and a coverage hole must be reported as a hole rather than as a zero.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncidentRecord } from './incident-types'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { readIncidentCounts, clampTopWorktrees } from './incident-counts'
import { createIncidentStore, type IncidentStore } from './incident-store'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function openStore(): { store: IncidentStore; opened: OpenIncidentsDatabase } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-counts-'))
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
    id: 'inc_counts_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-counts-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-counts-1',
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

const NOW = 1_700_000_000_000

/**
 * A class this build does not know, written straight to the table.
 *
 * `insertIncident` refuses it by contract, so this is the only way the read model can meet a row from
 * a newer build — which is exactly the case the tripwire "an unknown class still counts into
 * `untriaged`" exists for.
 */
function insertUnknownClassRow(
  opened: OpenIncidentsDatabase,
  options: { id: string; worktreeId: string | null; className: string }
): void {
  opened.db
    .prepare(
      `INSERT INTO incidents (id, source_kind, source_id, facet, host_id, worktree_id, class,
         status, fingerprint, evidence, summary, created_at)
       VALUES (?, 'pty_exit', ?, 'exit', 'host-a', ?, ?, 'untriaged', ?, ?, 'from a newer build', ?)`
    )
    .run(
      options.id,
      `src-${options.id}`,
      options.worktreeId,
      options.className,
      'e'.repeat(64),
      JSON.stringify({ pointers: [], unknownBoundaries: [] }),
      NOW
    )
}

function counts(
  store: IncidentStore,
  opened: OpenIncidentsDatabase,
  topWorktrees?: number
): ReturnType<typeof readIncidentCounts> {
  return readIncidentCounts({
    db: opened.db,
    coverage: store.coverage(),
    now: () => NOW,
    ...(topWorktrees === undefined ? {} : { topWorktrees })
  })
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

describe('readIncidentCounts', () => {
  it('reports an empty store as zero without inventing a coverage gap', () => {
    const { store, opened } = openStore()
    const value = counts(store, opened)
    expect(value.source).toEqual({ kind: 'local' })
    expect(value.availability).toBe('supported')
    expect(value.untriaged).toBe(0)
    expect(value.total).toBe(0)
    expect(value.byWorktree).toEqual([])
    expect(value.byClass).toEqual({
      crash: 0,
      no_progress: 0,
      tool_error: 0,
      acceptance_failed: 0,
      acceptance_overridden: 0,
      unknown_state: 0
    })
    expect(value.coverage).toMatchObject({
      currentlyLimited: false,
      capacityLatchSet: false,
      shadowReplayIncomplete: false,
      remoteIncidentCapture: 'unsupported',
      gap: false
    })
    expect(value.readAt).toBe(NOW)
  })

  it('counts a duplicate insert once, because a refused repeat is not a new row', () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    // Same (source_kind, source_id, facet): a no-op by contract, not a second incident.
    store.insertIncident(record({ id: 'inc_counts_2' }))
    expect(counts(store, opened).untriaged).toBe(1)
    expect(counts(store, opened).total).toBe(1)
  })

  it('splits the untriaged set by class, by worktree, and drops a row from the count when triaged', () => {
    const { store, opened } = openStore()
    store.insertIncident(record({ id: 'inc_a', sourceId: 's1', worktreeId: 'wt-1' }))
    store.insertIncident(
      record({ id: 'inc_b', sourceId: 's2', worktreeId: 'wt-1', class: 'no_progress' })
    )
    store.insertIncident(
      record({ id: 'inc_c', sourceId: 's3', worktreeId: 'wt-2', class: 'tool_error' })
    )
    // No worktree binding: counted, but not attributable to any worktree.
    store.insertIncident(record({ id: 'inc_d', sourceId: 's4', worktreeId: null, class: 'crash' }))

    const before = counts(store, opened)
    expect(before.untriaged).toBe(4)
    expect(before.total).toBe(4)
    expect(before.byClass.crash).toBe(2)
    expect(before.byClass.no_progress).toBe(1)
    expect(before.byClass.tool_error).toBe(1)
    // Invariant: the breakdown and the total cannot disagree.
    expect(Object.values(before.byClass).reduce((sum, n) => sum + n, 0)).toBe(before.untriaged)
    // Biggest first, and the unattributed row is genuinely absent rather than bucketed under a fake id.
    expect(before.byWorktree).toEqual([
      { worktreeId: 'wt-1', untriaged: 2 },
      { worktreeId: 'wt-2', untriaged: 1 }
    ])

    // A decision moves the *projected* status; the row itself stays `untriaged` (immutability).
    expect(
      store.appendDecision({ incidentId: 'inc_b', toStatus: 'watch', actor: 'alice', reason: 'r' })
    ).toMatchObject({ outcome: 'appended' })

    const after = counts(store, opened)
    expect(after.untriaged).toBe(3)
    expect(after.total).toBe(4)
    expect(after.byClass.no_progress).toBe(0)
    expect(after.byWorktree).toEqual([
      { worktreeId: 'wt-1', untriaged: 1 },
      { worktreeId: 'wt-2', untriaged: 1 }
    ])
    expect(store.getIncident('inc_b')?.status).toBe('untriaged')
  })

  it('caps the worktree breakdown at topWorktrees, deterministically', () => {
    const { store, opened } = openStore()
    for (let index = 0; index < 4; index += 1) {
      store.insertIncident(record({ id: `inc_${index}`, sourceId: `s${index}`, worktreeId: 'wt-x' }))
    }
    for (let index = 4; index < 6; index += 1) {
      store.insertIncident(record({ id: `inc_${index}`, sourceId: `s${index}`, worktreeId: 'wt-y' }))
    }
    expect(counts(store, opened, 1).byWorktree).toEqual([{ worktreeId: 'wt-x', untriaged: 4 }])
    expect(counts(store, opened, 2).byWorktree.map((entry) => entry.worktreeId)).toEqual([
      'wt-x',
      'wt-y'
    ])
    // Same counts must not reshuffle between reads (ties break on the worktree id).
    expect(counts(store, opened, 2).byWorktree).toEqual(counts(store, opened, 2).byWorktree)
  })

  it('drops pruned rows from the counts', () => {
    const { store, opened } = openStore()
    const old = NOW - 200 * 24 * 60 * 60 * 1000
    store.insertIncident(record({ id: 'inc_old', sourceId: 's-old', createdAt: old }))
    store.insertIncident(record({ id: 'inc_new', sourceId: 's-new', createdAt: NOW }))
    store.appendDecision({ incidentId: 'inc_old', toStatus: 'invalid', actor: 'alice', reason: 'r' })
    expect(counts(store, opened).untriaged).toBe(1)

    // Dry run first: reporting candidates must not change the counts.
    expect(store.pruneIncidents({ dryRun: true, olderThanDays: 90, now: NOW }).candidates).toBe(1)
    expect(counts(store, opened).total).toBe(2)

    const pruned = store.pruneIncidents({ dryRun: false, olderThanDays: 90, now: NOW })
    expect(pruned.deleted).toBe(1)
    const after = counts(store, opened)
    expect(after.total).toBe(1)
    expect(after.untriaged).toBe(1)
    expect(after.byClass.crash).toBe(1)
  })

  it('counts a capacity latch as a local gap: a past refusal still means rows may be missing', () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    // The latch is durable meta written by the capacity gate; the same flag `coverage()` reads.
    opened.db.prepare(
      "INSERT INTO incident_store_meta (key, value) VALUES ('capacity_limited', '1') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run()
    const value = counts(store, opened)
    // §11.5 still distinguishes the two capacity fields for wording; `gap` is the single "is the
    // number complete?" answer, and a latch makes it a lower bound.
    expect(value.coverage).toMatchObject({
      capacityLatchSet: true,
      currentlyLimited: false,
      gap: true
    })
  })

  it('stays a floor, not a verdict, when the store reports a current coverage hole', () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    // Simulate an unfinished replay: the only durable seed is the meta flag (M2-C4).
    opened.db.prepare(
      "INSERT INTO incident_store_meta (key, value) VALUES ('shadow_replay_incomplete', '1') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run()
    const value = counts(store, opened)
    expect(value.untriaged).toBe(1)
    expect(value.coverage).toMatchObject({ shadowReplayIncomplete: true, gap: true })
  })

  it('counts dropped replay lines as a local gap: those rows can never appear (C3)', () => {
    const { store, opened } = openStore()
    store.insertIncident(record())
    // `shadow_dropped` is the durable count of lines the store refused for capacity. The replay is
    // not `incomplete` and the latch is not set, so the dropped count is the only hole: without it
    // the badge could state a complete number while the panel said rows were lost permanently.
    opened.db.prepare(
      "INSERT INTO incident_store_meta (key, value) VALUES ('shadow_dropped', '3') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run()
    const value = counts(store, opened)
    expect(value.untriaged).toBe(1)
    expect(value.coverage).toMatchObject({
      currentlyLimited: false,
      capacityLatchSet: false,
      shadowReplayIncomplete: false,
      shadowReplayDropped: 3,
      gap: true
    })
  })
})

describe('readIncidentCounts: one scan (A1/B-F3)', () => {
  it('derives untriaged, total, byClass and top-N from a single grouped query', () => {
    const { store, opened } = openStore()
    store.insertIncident(
      record({ id: 'inc_a', sourceId: 'sa', worktreeId: 'wt-2', class: 'crash' })
    )
    store.insertIncident(
      record({ id: 'inc_b', sourceId: 'sb', worktreeId: 'wt-2', class: 'crash' })
    )
    store.insertIncident(
      record({ id: 'inc_c', sourceId: 'sc', worktreeId: 'wt-1', class: 'tool_error' })
    )
    // No worktree binding: counted, never attributed.
    store.insertIncident(
      record({ id: 'inc_d', sourceId: 'sd', worktreeId: null, class: 'no_progress' })
    )
    // Triaged away: still a row (`total`), no longer untriaged.
    store.appendDecision({ incidentId: 'inc_c', toStatus: 'watch', actor: 'alice', reason: 'r' })
    insertUnknownClassRow(opened, { id: 'inc_future', worktreeId: 'wt-1', className: 'future' })

    const coverage = store.coverage()
    const prepare = vi.spyOn(opened.db, 'prepare')
    const value = readIncidentCounts({ db: opened.db, coverage, topWorktrees: 2, now: () => NOW })
    const statements = prepare.mock.calls.map((call) => String(call[0]))
    prepare.mockRestore()

    expect(value.untriaged).toBe(4)
    expect(value.total).toBe(5)
    // The unknown class counts into the total and into `untriaged`, and gets no invented key.
    expect(value.byClass).toEqual({
      crash: 2,
      no_progress: 1,
      tool_error: 0,
      acceptance_failed: 0,
      acceptance_overridden: 0,
      unknown_state: 0
    })
    expect(value.byWorktree).toEqual([
      { worktreeId: 'wt-2', untriaged: 2 },
      { worktreeId: 'wt-1', untriaged: 1 }
    ])

    // One statement reads `incidents` at all, and it is the grouped one: the previous shape read the
    // table three times, two of them through the correlated `incident_state` view.
    const incidentReads = statements.filter((sql) => /\bFROM incidents\b/i.test(sql))
    expect(incidentReads).toHaveLength(1)
    expect(incidentReads[0]).toMatch(/GROUP BY\s+i\.class,\s*i\.worktree_id/i)
  })
})

describe('clampTopWorktrees', () => {
  it('defaults, floors and caps the caller-requested size', () => {
    expect(clampTopWorktrees(undefined)).toBe(5)
    expect(clampTopWorktrees(0)).toBe(5)
    expect(clampTopWorktrees(-3)).toBe(5)
    expect(clampTopWorktrees(Number.NaN)).toBe(5)
    expect(clampTopWorktrees(3)).toBe(3)
    expect(clampTopWorktrees(3.9)).toBe(3)
    expect(clampTopWorktrees(10_000)).toBe(100)
  })
})
