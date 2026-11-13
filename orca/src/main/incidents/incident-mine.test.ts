/**
 * Clustering into triage candidates (§10, M6-1) — the read-only half.
 *
 * The tests pin the policy at its edges rather than the implementation: the window boundary, the exact
 * row/source-id thresholds, terminal exclusion, and the caps that make the pass bounded. Each case
 * builds a real incidents database so the SQL (join + effective status) is exercised, not a mock.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { IncidentClass, IncidentRecord, IncidentSourceKind } from './incident-types'
import { incidentFingerprint } from './incident-key'
import {
  DEFAULT_MINE_MAX_CANDIDATES,
  DEFAULT_MINE_MAX_GROUPS,
  MINE_RULE_ACCEPTANCE_INVARIANT,
  MINE_RULE_CRASH_SIGNALED,
  MINE_RULE_REPEAT_FINGERPRINT,
  MINER_ACTOR,
  applyMineCandidates,
  buildIncidentMine,
  mineDecisionReason,
  mineRulesFor,
  type MineRuleRow,
  type MineStore
} from './incident-mine'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []

function fixture(): { db: OpenIncidentsDatabase['db']; store: IncidentStore } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-mine-'))
  directories.push(directory)
  const database = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  opened.push(database)
  return {
    db: database.db,
    store: createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes })
  }
}

let sequence = 0

type SeedOptions = {
  fingerprint: string
  sourceId?: string
  class?: IncidentClass
  sourceKind?: IncidentSourceKind
  facet?: string
  createdAt?: number
  worktreeId?: string | null
  runId?: string | null
  exitCause?: IncidentRecord['exitCause']
}

function seed(store: IncidentStore, options: SeedOptions): IncidentRecord {
  sequence += 1
  const cls = options.class ?? 'crash'
  const sourceKind = options.sourceKind ?? 'pty_exit'
  const facet = options.facet ?? 'exit'
  const record: IncidentRecord = {
    id: `inc_mine_${sequence}`,
    sourceKind,
    sourceId: options.sourceId ?? `src_${sequence}`,
    facet,
    hostId: 'host-a',
    worktreeId: options.worktreeId ?? 'wt-a',
    runId: options.runId ?? 'run-a',
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: cls,
    status: 'untriaged',
    exitCause: options.exitCause ?? { kind: 'exited', exitCode: 1 },
    fingerprint: options.fingerprint,
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: `seeded ${cls}`,
    createdAt: options.createdAt ?? T0
  }
  store.insertIncident(record)
  return record
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

describe('candidate rules (constants, not configuration)', () => {
  function row(overrides: Partial<MineRuleRow> = {}): MineRuleRow {
    return {
      id: 'inc_1',
      class: 'crash',
      sourceKind: 'pty_exit',
      sourceId: 'src_1',
      facet: 'exit',
      fingerprint: 'fp',
      createdAt: T0,
      worktreeId: null,
      runId: null,
      effectiveStatus: 'untriaged',
      exitCause: { kind: 'exited', exitCode: 1 },
      ...overrides
    }
  }

  it('promotes 3 rows from 2 distinct source ids, and not 2 rows', () => {
    expect(mineRulesFor([row({ id: 'a', sourceId: 's1' }), row({ id: 'b', sourceId: 's2' })])).toEqual(
      []
    )
    expect(
      mineRulesFor([
        row({ id: 'a', sourceId: 's1' }),
        row({ id: 'b', sourceId: 's2' }),
        row({ id: 'c', sourceId: 's3' })
      ])
    ).toContain(MINE_RULE_REPEAT_FINGERPRINT)
  })

  it('does not promote 3 rows that all come from one source id', () => {
    const rules = mineRulesFor([
      row({ id: 'a', sourceId: 'same' }),
      row({ id: 'b', sourceId: 'same' }),
      row({ id: 'c', sourceId: 'same' })
    ])
    expect(rules).not.toContain(MINE_RULE_REPEAT_FINGERPRINT)
  })

  it('lets a signalled crash cluster qualify on two rows', () => {
    const rules = mineRulesFor([
      row({ id: 'a', sourceId: 's1', exitCause: { kind: 'signaled', signal: 9 } }),
      row({ id: 'b', sourceId: 's1', exitCause: { kind: 'signaled', signal: 9 } })
    ])
    expect(rules).toEqual([MINE_RULE_CRASH_SIGNALED])
  })

  it('does not use the signalled-crash rule for a plain non-zero exit', () => {
    const rules = mineRulesFor([
      row({ id: 'a', sourceId: 's1' }),
      row({ id: 'b', sourceId: 's1' })
    ])
    expect(rules).toEqual([])
  })

  it('lets an acceptance cluster on one invariant qualify on two rows', () => {
    const rules = mineRulesFor([
      row({ id: 'a', sourceId: 'd1', class: 'acceptance_failed', sourceKind: 'acceptance', facet: 'rule:tests', exitCause: null }),
      row({ id: 'b', sourceId: 'd1', class: 'acceptance_failed', sourceKind: 'acceptance', facet: 'rule:tests', exitCause: null })
    ])
    expect(rules).toEqual([MINE_RULE_ACCEPTANCE_INVARIANT])
  })

  it('does not let two acceptance rules share the small-cluster rule', () => {
    const rules = mineRulesFor([
      row({ id: 'a', sourceId: 'd1', class: 'acceptance_failed', sourceKind: 'acceptance', facet: 'rule:tests', exitCause: null }),
      row({ id: 'b', sourceId: 'd1', class: 'acceptance_failed', sourceKind: 'acceptance', facet: 'rule:lint', exitCause: null })
    ])
    expect(rules).toEqual([])
  })
})

describe('buildIncidentMine', () => {
  it('groups by fingerprint inside the window and reports the cluster shape', () => {
    const { db, store } = fixture()
    const fingerprint = incidentFingerprint({
      class: 'crash',
      sourceKind: 'pty_exit',
      facet: 'exit',
      signature: ['signaled:9']
    })
    seed(store, { fingerprint, sourceId: 'pty_1', createdAt: T0 + 1 * DAY, worktreeId: 'wt-a' })
    seed(store, { fingerprint, sourceId: 'pty_2', createdAt: T0 + 2 * DAY, worktreeId: 'wt-b' })
    seed(store, { fingerprint, sourceId: 'pty_3', createdAt: T0 + 3 * DAY, worktreeId: 'wt-b' })
    // Outside the 7d window: must not be counted.
    seed(store, { fingerprint, sourceId: 'pty_old', createdAt: T0 - 1 * DAY, worktreeId: 'wt-c' })

    const mine = buildIncidentMine(db, { now: T0 + 7 * DAY, windowMs: 7 * DAY })
    expect(mine.totals.rowsInWindow).toBe(3)
    expect(mine.totals.clusters).toBe(1)
    expect(mine.clusters[0]).toMatchObject({
      fingerprint,
      count: 3,
      distinctSourceIds: 3,
      firstSeen: T0 + 1 * DAY,
      lastSeen: T0 + 3 * DAY,
      worktreeCount: 2,
      runCount: 1,
      untriagedCount: 3,
      hasUntriaged: true
    })
    expect(mine.clusters[0].rules).toContain(MINE_RULE_REPEAT_FINGERPRINT)
    expect(mine.clusters[0].byClass).toEqual([{ value: 'crash', count: 3 }])
    expect(mine.candidates.map((candidate) => candidate.incidentId)).toEqual([
      'inc_mine_1',
      'inc_mine_2',
      'inc_mine_3'
    ])
  })

  it('includes a row exactly at the window edge and excludes one millisecond before it', () => {
    const { db, store } = fixture()
    const now = T0 + 7 * DAY
    const since = now - 7 * DAY
    seed(store, { fingerprint: 'fp-edge-in', sourceId: 's1', createdAt: since })
    seed(store, { fingerprint: 'fp-edge-out', sourceId: 's2', createdAt: since - 1 })
    const mine = buildIncidentMine(db, { now, windowMs: 7 * DAY })
    expect(mine.totals.rowsInWindow).toBe(1)
    expect(mine.clusters[0].fingerprint).toBe('fp-edge-in')
  })

  it('excludes duplicate/invalid/closed rows from the counts and reports how many', () => {
    const { db, store } = fixture()
    const fingerprint = 'fp-dismissed'
    seed(store, { fingerprint, sourceId: 's1' })
    seed(store, { fingerprint, sourceId: 's2' })
    const duplicate = seed(store, { fingerprint, sourceId: 's3' })
    const invalid = seed(store, { fingerprint, sourceId: 's4' })
    store.appendDecision({ incidentId: duplicate.id, toStatus: 'duplicate', actor: 'alice', reason: 'same thing' })
    store.appendDecision({ incidentId: invalid.id, toStatus: 'invalid', actor: 'alice', reason: 'not a bug' })

    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.totals.rowsInWindow).toBe(4)
    // Two live rows cannot satisfy the 3-row rule; the two triaged rows must not push it over.
    expect(mine.clusters[0].count).toBe(2)
    expect(mine.clusters[0].rules).toEqual([])
    expect(mine.excluded).toEqual({
      total: 2,
      byStatus: [
        { status: 'duplicate', count: 1 },
        { status: 'invalid', count: 1 }
      ]
    })
  })

  it('caps the reported groups but keeps the totals for the whole window', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 5; index += 1) {
      const fingerprint = `fp-${index}`
      seed(store, { fingerprint, sourceId: `${fingerprint}-a` })
      seed(store, { fingerprint, sourceId: `${fingerprint}-b` })
      seed(store, { fingerprint, sourceId: `${fingerprint}-c` })
    }
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY, maxGroups: 2 })
    expect(mine.clusters).toHaveLength(2)
    expect(mine.totals.clusters).toBe(5)
    expect(mine.truncated.groups).toBe(true)
    expect(mine.truncated.candidates).toBe(false)
  })

  it('caps candidates and reports that more existed', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 4; index += 1) {
      seed(store, { fingerprint: 'fp-cap', sourceId: `s${index}` })
    }
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY, maxCandidates: 2 })
    expect(mine.candidates).toHaveLength(2)
    expect(mine.totals.candidates).toBe(4)
    expect(mine.truncated.candidates).toBe(true)
    expect(DEFAULT_MINE_MAX_CANDIDATES).toBe(20)
    expect(DEFAULT_MINE_MAX_GROUPS).toBe(20)
  })

  it('stops on the time budget and says the candidate set is partial', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 4; index += 1) {
      seed(store, { fingerprint: 'fp-budget', sourceId: `s${index}` })
    }
    let tick = 0
    const mine = buildIncidentMine(db, {
      now: T0 + DAY,
      windowMs: 7 * DAY,
      timeBudgetMs: 1,
      // First call sets the start, then every check is over budget.
      clock: () => (tick++ === 0 ? 0 : 5)
    })
    expect(mine.truncated.timeBudget).toBe(true)
    expect(mine.candidates).toHaveLength(0)
    expect(mine.totals.candidates).toBe(4)
  })

  it('marks a fully triaged cluster as reported but not a candidate', () => {
    const { db, store } = fixture()
    const fingerprint = 'fp-watched'
    for (let index = 0; index < 3; index += 1) {
      const record = seed(store, { fingerprint, sourceId: `s${index}` })
      store.appendDecision({ incidentId: record.id, toStatus: 'watch', actor: 'alice', reason: 'seen' })
    }
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.clusters[0]).toMatchObject({ hasUntriaged: false, untriagedCount: 0 })
    // The rule still applies — the pattern exists — but there is no untriaged row to suggest.
    expect(mine.clusters[0].rules).toContain(MINE_RULE_REPEAT_FINGERPRINT)
    expect(mine.candidates).toEqual([])
    expect(mine.totals.candidates).toBe(0)
  })

  it('promotes nothing when every cluster is already dismissed (terminal rows excluded)', () => {
    const { db, store } = fixture()
    const fingerprint = 'fp-all-dismissed'
    for (let index = 0; index < 4; index += 1) {
      const record = seed(store, { fingerprint, sourceId: `s${index}` })
      store.appendDecision({
        incidentId: record.id,
        toStatus: index % 2 === 0 ? 'duplicate' : 'invalid',
        actor: 'alice',
        reason: 'dismissed'
      })
    }
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.totals.rowsInWindow).toBe(4)
    expect(mine.totals.clusters).toBe(0)
    expect(mine.candidates).toEqual([])
    expect(mine.excluded).toMatchObject({ total: 4 })
  })

  it('never writes: no decisions and no new rows are added by a mining pass', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 3; index += 1) {
      seed(store, { fingerprint: 'fp-read', sourceId: `s${index}` })
    }
    const before = store.countIncidents()
    buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(store.countIncidents()).toBe(before)
    expect(store.listIncidents({ limit: 10 }).incidents.every((row) => row.decisionCount === 0)).toBe(
      true
    )
  })
})

describe('applying miner decisions (M6-2)', () => {
  function seedCluster(
    store: IncidentStore,
    fingerprint: string,
    rows = 3
  ): string[] {
    const ids: string[] = []
    for (let index = 0; index < rows; index += 1) {
      ids.push(seed(store, { fingerprint, sourceId: `${fingerprint}-${index}` }).id)
    }
    return ids
  }

  function decisionCount(store: IncidentStore): number {
    return store.listIncidents({ limit: 100 }).incidents.reduce(
      (sum, row) => sum + row.decisionCount,
      0
    )
  }

  it('appends one decision per candidate with actor=miner and a rule-named reason', () => {
    const { db, store } = fixture()
    const ids = seedCluster(store, 'fp-apply')
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY, target: 'watch' })
    const applied = applyMineCandidates(store, mine, { now: () => T0 + 2 * DAY })

    expect(applied).toMatchObject({ attempted: 3, appended: 3, skipped: 0 })
    expect(decisionCount(store)).toBe(3)
    const view = store.getIncident(ids[0])!
    expect(view.effectiveStatus).toBe('watch')
    expect(view.decisions[0]).toMatchObject({ actor: MINER_ACTOR, toStatus: 'watch' })
    expect(view.decisions[0].reason).toContain('rule=repeat_fingerprint')
    expect(view.decisions[0].reason).toContain('count=3')
    expect(view.decisions[0].reason).toContain('distinct_source_ids=3')
    expect(view.decisions[0].reason).toContain('first=')
    expect(view.decisions[0].reason).toContain('last=')
  })

  it('is idempotent: a second apply appends nothing and the decision log does not grow', () => {
    const { db, store } = fixture()
    seedCluster(store, 'fp-idem')
    const first = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(applyMineCandidates(store, first).appended).toBe(3)
    const afterFirst = decisionCount(store)

    const second = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    // The rows are now `watch`, so they are no longer untriaged candidates at all.
    expect(second.totals.candidates).toBe(0)
    expect(second.candidates).toEqual([])
    const applied = applyMineCandidates(store, second)
    expect(applied).toMatchObject({ attempted: 0, appended: 0, skipped: 0 })
    expect(decisionCount(store)).toBe(afterFirst)
  })

  it('skips a row that is already in the target state even when it is a candidate', () => {
    const { db, store } = fixture()
    const ids = seedCluster(store, 'fp-already')
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY, target: 'watch' })
    // A hand decision arrives between mining and applying.
    store.appendDecision({ incidentId: ids[0], toStatus: 'watch', actor: 'alice', reason: 'seen' })
    const applied = applyMineCandidates(store, mine)
    expect(applied.appended).toBe(2)
    expect(applied.results.find((result) => result.incidentId === ids[0])?.outcome).toBe(
      'skipped_already_target'
    )
  })

  it('never touches a terminal row', () => {
    const { db, store } = fixture()
    const ids = seedCluster(store, 'fp-terminal')
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    store.appendDecision({
      incidentId: ids[0],
      toStatus: 'duplicate',
      actor: 'alice',
      reason: 'same incident'
    })
    const applied = applyMineCandidates(store, mine)
    const duplicate = applied.results.find((result) => result.incidentId === ids[0])
    expect(duplicate?.outcome).toBe('skipped_terminal')
    expect(store.getIncident(ids[0])?.effectiveStatus).toBe('duplicate')
  })

  it('reports a read-only store for every candidate instead of throwing', () => {
    const { db, store } = fixture()
    seedCluster(store, 'fp-readonly')
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    const readOnly: MineStore = {
      ...store,
      readOnly: true,
      appendDecision: () => {
        throw new Error('a read-only store must not be written')
      }
    }
    const applied = applyMineCandidates(readOnly, mine)
    expect(applied.appended).toBe(0)
    expect(applied.results.every((result) => result.outcome === 'skipped_read_only')).toBe(true)
  })

  it('writes a reason that carries statistics but never an incident body', () => {
    const { db, store } = fixture()
    seedCluster(store, 'fp-reason')
    const mine = buildIncidentMine(db, { now: T0 + DAY, windowMs: 7 * DAY })
    const reason = mineDecisionReason(mine.candidates[0])
    expect(reason).toContain('miner rule=repeat_fingerprint')
    expect(reason).toContain('fingerprint=fp-reason')
    // The seeded summary never appears in the decision text.
    expect(reason).not.toContain('seeded crash')
    expect(reason.length).toBeLessThanOrEqual(500)
  })
})
