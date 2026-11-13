/**
 * Clustering into triage candidates (§10, M6) — including the review's C1/C2/C4/C5 edges.
 *
 * The tests pin the policy at its edges rather than the implementation: the window boundary, the
 * epoch-versus-entity distinction, terminal/self-report exclusion, single-entity recurrence, the
 * low-information budget, the scan cap, and the apply guards. Each case builds a real incidents
 * database so the SQL (join, effective status, decision projection) is exercised, not a mock.
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
  MINE_MAX_LOW_INFORMATION_CANDIDATES,
  MINE_RULE_ACCEPTANCE_INVARIANT,
  MINE_RULE_CRASH_SIGNALED,
  MINE_RULE_REPEAT_FINGERPRINT,
  MINER_ACTOR,
  applyMineCandidates,
  buildIncidentMine,
  countStableSources,
  dispatchIdFromAcceptanceSourceId,
  mineDecisionReason,
  mineRulesFor,
  paneKeyFromStallSourceId,
  stableSourceIdentity,
  toolErrorSourceParts,
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

/** Every mining pass embeds the digest, which needs the store's own coverage report. */
function mineWindow(
  db: OpenIncidentsDatabase['db'],
  store: IncidentStore,
  options: Omit<Parameters<typeof buildIncidentMine>[1], 'coverage'>
) {
  return buildIncidentMine(db, { ...options, coverage: store.coverage() })
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
  agentSessionId?: string | null
  dispatchId?: string | null
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
    worktreeId: options.worktreeId === undefined ? 'wt-a' : options.worktreeId,
    runId: options.runId === undefined ? 'run-a' : options.runId,
    taskId: null,
    dispatchId: options.dispatchId ?? null,
    agentSessionId: options.agentSessionId ?? null,
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

describe('stable source identity (M6-C1)', () => {
  it('derives a pane key from a stall source id and drops the epoch', () => {
    expect(paneKeyFromStallSourceId('tab-1:leaf-1:1700000000000')).toBe('tab-1:leaf-1')
    expect(paneKeyFromStallSourceId('not-a-pane-key')).toBeNull()
    expect(
      stableSourceIdentity({
        sourceKind: 'status_stall',
        sourceId: 'tab-1:leaf-1:1700000000000',
        facet: 'stall'
      })
    ).toEqual({ dimension: 'pane', key: 'pane:tab-1:leaf-1' })
  })

  it('keeps the session and the code for a tool error, and drops turn/window', () => {
    expect(toolErrorSourceParts('sess-1:turn-2:permission_denied:1700000000000')).toEqual({
      sessionId: 'sess-1',
      code: 'permission_denied'
    })
    expect(
      stableSourceIdentity({
        sourceKind: 'tool_error',
        sourceId: 'sess-1:turn-2:permission_denied:1700000000000',
        facet: 'tool:permission_denied'
      })
    ).toEqual({ dimension: 'session', key: 'session:sess-1:code:permission_denied' })
    // A different turn of the same session is the SAME stable source.
    expect(
      stableSourceIdentity({
        sourceKind: 'tool_error',
        sourceId: 'sess-1:turn-9:permission_denied:1700000005000',
        facet: 'tool:permission_denied'
      })?.key
    ).toBe('session:sess-1:code:permission_denied')
  })

  it('keys acceptance by dispatch + rule, so the attempt is not a source', () => {
    expect(dispatchIdFromAcceptanceSourceId('disp-1:1')).toBe('disp-1')
    expect(
      stableSourceIdentity({
        sourceKind: 'acceptance',
        sourceId: 'disp-1:1',
        facet: 'rule:tests',
        dispatchId: 'disp-1'
      })
    ).toEqual({ dimension: 'dispatch', key: 'dispatch:disp-1:rule:tests' })
    // Two rules on one dispatch stay distinct entities.
    expect(
      stableSourceIdentity({
        sourceKind: 'acceptance',
        sourceId: 'disp-1:1',
        facet: 'rule:lint',
        dispatchId: 'disp-1'
      })?.key
    ).not.toBe('dispatch:disp-1:rule:tests')
  })

  it('falls back session -> worktree -> run for a pty exit, and reports unknown otherwise', () => {
    expect(
      stableSourceIdentity({
        sourceKind: 'pty_exit',
        sourceId: 'inc-1',
        facet: 'exit',
        agentSessionId: 'sess-9',
        worktreeId: 'wt-1'
      })
    ).toEqual({ dimension: 'session', key: 'session:sess-9' })
    expect(
      stableSourceIdentity({
        sourceKind: 'pty_exit',
        sourceId: 'inc-1',
        facet: 'exit',
        worktreeId: 'wt-1',
        runId: 'run-1'
      })
    ).toEqual({ dimension: 'worktree', key: 'worktree:wt-1' })
    expect(
      stableSourceIdentity({
        sourceKind: 'pty_exit',
        sourceId: 'inc-1',
        facet: 'exit',
        runId: 'run-1'
      })
    ).toEqual({ dimension: 'run', key: 'run:run-1' })
    expect(stableSourceIdentity({ sourceKind: 'pty_exit', sourceId: 'inc-1', facet: 'exit' })).toBeNull()
  })

  it('declares self-report out of mining instead of inventing a source', () => {
    expect(
      stableSourceIdentity({ sourceKind: 'self_report', sourceId: 'req-1', facet: 'report' })
    ).toBeNull()
  })
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
      worktreeId: 'wt-a',
      runId: null,
      agentSessionId: null,
      dispatchId: null,
      effectiveStatus: 'untriaged',
      lastDecisionAt: null,
      exitCause: { kind: 'exited', exitCode: 1 },
      ...overrides
    }
  }

  it('promotes 3 rows from 2 distinct ENTITIES, and not 2 rows', () => {
    const sameWorktree = [
      row({ id: 'a', worktreeId: 'wt-a' }),
      row({ id: 'b', worktreeId: 'wt-b' })
    ]
    expect(mineRulesFor(sameWorktree)).toEqual([])
    expect(
      mineRulesFor([
        row({ id: 'a', worktreeId: 'wt-a' }),
        row({ id: 'b', worktreeId: 'wt-b' }),
        row({ id: 'c', worktreeId: 'wt-c' })
      ])
    ).toContain(MINE_RULE_REPEAT_FINGERPRINT)
  })

  it('does not promote 3 rows that are the same entity even with 3 source ids', () => {
    // The epoch lives in source_id; three stalls of one pane are three rows, one entity.
    const rows = [1700000000000, 1700000005000, 1700000009000].map((epoch, index) =>
      row({
        id: `a${index}`,
        class: 'no_progress',
        sourceKind: 'status_stall',
        sourceId: `tab-1:leaf-1:${epoch}`,
        facet: 'stall',
        worktreeId: 'wt-a',
        runId: null,
        exitCause: null
      })
    )
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('promotes 3 stalls from 2 different panes', () => {
    const rows = [
      row({ id: 'a', class: 'no_progress', sourceKind: 'status_stall', sourceId: 'tab-1:leaf-1:100', facet: 'stall', exitCause: null, worktreeId: null, runId: null }),
      row({ id: 'b', class: 'no_progress', sourceKind: 'status_stall', sourceId: 'tab-1:leaf-1:200', facet: 'stall', exitCause: null, worktreeId: null, runId: null }),
      row({ id: 'c', class: 'no_progress', sourceKind: 'status_stall', sourceId: 'tab-2:leaf-2:300', facet: 'stall', exitCause: null, worktreeId: null, runId: null })
    ]
    expect(countStableSources(rows)).toBe(2)
    expect(mineRulesFor(rows)).toContain(MINE_RULE_REPEAT_FINGERPRINT)
  })

  it('does not let one session\'s three turns become a source pattern', () => {
    const rows = [1, 2, 3].map((turn, index) =>
      row({
        id: `t${index}`,
        class: 'tool_error',
        sourceKind: 'tool_error',
        sourceId: `sess-1:turn-${turn}:permission_denied:1700000000000`,
        facet: 'tool:permission_denied',
        worktreeId: null,
        runId: null,
        exitCause: null
      })
    )
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('lets a signalled crash cluster qualify on two rows from two entities', () => {
    const rules = mineRulesFor([
      row({ id: 'a', worktreeId: 'wt-a', exitCause: { kind: 'signaled', signal: 9 } }),
      row({ id: 'b', worktreeId: 'wt-b', exitCause: { kind: 'signaled', signal: 9 } })
    ])
    expect(rules).toEqual([MINE_RULE_CRASH_SIGNALED])
  })

  it('does not promote two signalled crashes of one entity (single-entity recurrence, C2)', () => {
    const rows = [
      row({ id: 'a', worktreeId: 'wt-a', exitCause: { kind: 'signaled', signal: 9 } }),
      row({ id: 'b', worktreeId: 'wt-a', exitCause: { kind: 'signaled', signal: 9 } })
    ]
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('does not use the signalled-crash rule for a plain non-zero exit', () => {
    const rules = mineRulesFor([
      row({ id: 'a', worktreeId: 'wt-a' }),
      row({ id: 'b', worktreeId: 'wt-b' })
    ])
    expect(rules).toEqual([])
  })

  it('lets an acceptance cluster on one invariant qualify on two dispatches', () => {
    const rules = mineRulesFor([
      row({ id: 'a', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:1', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null }),
      row({ id: 'b', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-2:1', facet: 'rule:tests', dispatchId: 'disp-2', worktreeId: null, runId: null, exitCause: null })
    ])
    expect(rules).toEqual([MINE_RULE_ACCEPTANCE_INVARIANT])
  })

  it('does not promote two failures of the same acceptance rule on ONE dispatch (C2)', () => {
    const rows = [
      row({ id: 'a', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:1', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null }),
      row({ id: 'b', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:2', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null })
    ]
    expect(countStableSources(rows)).toBe(1)
    expect(mineRulesFor(rows)).toEqual([])
  })

  it('does not let two acceptance rules share the small-cluster rule', () => {
    const rules = mineRulesFor([
      row({ id: 'a', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-1:1', facet: 'rule:tests', dispatchId: 'disp-1', worktreeId: null, runId: null, exitCause: null }),
      row({ id: 'b', class: 'acceptance_failed', sourceKind: 'acceptance', sourceId: 'disp-2:1', facet: 'rule:lint', dispatchId: 'disp-2', worktreeId: null, runId: null, exitCause: null })
    ])
    expect(rules).toEqual([])
  })
})

describe('buildIncidentMine', () => {
  it('groups by fingerprint inside the window and reports rows and entities separately', () => {
    const { db, store } = fixture()
    const fingerprint = incidentFingerprint({
      class: 'crash',
      sourceKind: 'pty_exit',
      facet: 'exit',
      signature: ['signaled:9']
    })
    seed(store, { fingerprint, agentSessionId: 'sess-1', createdAt: T0 + 1 * DAY, worktreeId: 'wt-a' })
    seed(store, { fingerprint, agentSessionId: 'sess-2', createdAt: T0 + 2 * DAY, worktreeId: 'wt-b' })
    seed(store, { fingerprint, agentSessionId: 'sess-2', createdAt: T0 + 3 * DAY, worktreeId: 'wt-b' })
    // Outside the 7d window: must not be counted.
    seed(store, { fingerprint, agentSessionId: 'sess-old', createdAt: T0 - 1 * DAY })

    const mine = mineWindow(db, store, { now: T0 + 7 * DAY, windowMs: 7 * DAY })
    expect(mine.scan.rows).toBe(3)
    expect(mine.totals.clusters).toBe(1)
    expect(mine.clusters[0]).toMatchObject({
      fingerprint,
      count: 3,
      epochRows: 3,
      // Three rows, two entities: the distinction the review blocked on.
      stableSources: 2,
      unknownStableSource: 0,
      distinctSessions: 2,
      distinctWorktrees: 2,
      untriagedCount: 3,
      hasUntriaged: true,
      ownerAction: 'triage'
    })
    expect(mine.clusters[0].sourceDimensions).toEqual([{ dimension: 'session', count: 2 }])
    expect(mine.clusters[0].rules).toContain(MINE_RULE_REPEAT_FINGERPRINT)
    expect(mine.clusters[0].summary).toBe('crash/pty_exit')
    expect(mine.candidates).toHaveLength(3)
  })

  it('includes a row exactly at the window edge and excludes one millisecond before it', () => {
    const { db, store } = fixture()
    const now = T0 + 7 * DAY
    const since = now - 7 * DAY
    seed(store, { fingerprint: 'fp-edge-in', createdAt: since })
    seed(store, { fingerprint: 'fp-edge-out', createdAt: since - 1 })
    const mine = mineWindow(db, store, { now, windowMs: 7 * DAY })
    expect(mine.scan.rows).toBe(1)
    expect(mine.clusters[0].fingerprint).toBe('fp-edge-in')
  })

  it('excludes duplicate/invalid/closed rows from the counts and reports how many', () => {
    const { db, store } = fixture()
    const fingerprint = 'fp-dismissed'
    seed(store, { fingerprint, worktreeId: 'wt-a' })
    seed(store, { fingerprint, worktreeId: 'wt-b' })
    const duplicate = seed(store, { fingerprint, worktreeId: 'wt-c' })
    const invalid = seed(store, { fingerprint, worktreeId: 'wt-d' })
    store.appendDecision({ incidentId: duplicate.id, toStatus: 'duplicate', actor: 'alice', reason: 'same thing' })
    store.appendDecision({ incidentId: invalid.id, toStatus: 'invalid', actor: 'alice', reason: 'not a bug' })

    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.scan.rows).toBe(4)
    // Two live rows cannot satisfy the 3-row rule; the two triaged rows must not push it over.
    expect(mine.clusters[0].count).toBe(2)
    expect(mine.clusters[0].rules).toEqual([])
    expect(mine.excluded).toEqual({
      total: 2,
      byStatus: [
        { status: 'duplicate', count: 1 },
        { status: 'invalid', count: 1 }
      ],
      byReason: { terminal: 2, selfReport: 0 }
    })
  })

  it('caps the reported groups but keeps the totals for the whole window', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 5; index += 1) {
      const fingerprint = `fp-${index}`
      seed(store, { fingerprint, worktreeId: `${fingerprint}-a` })
      seed(store, { fingerprint, worktreeId: `${fingerprint}-b` })
      seed(store, { fingerprint, worktreeId: `${fingerprint}-c` })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY, maxGroups: 2 })
    expect(mine.clusters).toHaveLength(2)
    expect(mine.totals.clusters).toBe(5)
    expect(mine.truncated.groups).toBe(true)
    expect(mine.truncated.candidates).toBe(false)
  })

  it('caps candidates and reports that more existed', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 4; index += 1) {
      seed(store, { fingerprint: 'fp-cap', worktreeId: `wt-${index}` })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY, maxCandidates: 2 })
    expect(mine.candidates).toHaveLength(2)
    expect(mine.totals.candidates).toBe(4)
    expect(mine.truncated.candidates).toBe(true)
    expect(DEFAULT_MINE_MAX_CANDIDATES).toBe(20)
    expect(DEFAULT_MINE_MAX_GROUPS).toBe(20)
  })

  it('bounds the SCAN itself, keeps the newest rows, and says the totals are partial (C4)', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 5; index += 1) {
      seed(store, {
        fingerprint: 'fp-scan',
        worktreeId: `wt-${index}`,
        createdAt: T0 + index * 1000
      })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY, maxScanRows: 3 })
    expect(mine.scan).toMatchObject({ rows: 3, limit: 3, truncated: true })
    expect(mine.totals.rowsInWindow).toBe(3)
    expect(mine.truncated.scan).toBe(true)
    // Newest-first slice, so the two oldest rows are the ones not read.
    expect(mine.clusters[0].firstSeen).toBe(T0 + 2000)
    expect(mine.clusters[0].lastSeen).toBe(T0 + 4000)
  })

  it('does not report scan truncation when the window fits', () => {
    const { db, store } = fixture()
    seed(store, { fingerprint: 'fp-small', worktreeId: 'wt-a' })
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY, maxScanRows: 10 })
    expect(mine.scan.truncated).toBe(false)
    expect(mine.truncated.scan).toBe(false)
  })

  it('stops on the time budget and says the candidate set is partial', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 4; index += 1) {
      seed(store, { fingerprint: 'fp-budget', worktreeId: `wt-${index}` })
    }
    let tick = 0
    const mine = mineWindow(db, store, {
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
      const record = seed(store, { fingerprint, worktreeId: `wt-${index}` })
      store.appendDecision({ incidentId: record.id, toStatus: 'watch', actor: 'alice', reason: 'seen' })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.clusters[0]).toMatchObject({
      hasUntriaged: false,
      untriagedCount: 0,
      ownerAction: 'reviewed'
    })
    // The rule still applies — the pattern exists — but there is no untriaged row to suggest.
    expect(mine.clusters[0].rules).toContain(MINE_RULE_REPEAT_FINGERPRINT)
    expect(mine.candidates).toEqual([])
    expect(mine.totals.candidates).toBe(0)
    expect(mine.clusters[0].latestDecisionAt).not.toBeNull()
  })

  it('promotes nothing when every cluster is already dismissed (terminal rows excluded)', () => {
    const { db, store } = fixture()
    const fingerprint = 'fp-all-dismissed'
    for (let index = 0; index < 4; index += 1) {
      const record = seed(store, { fingerprint, worktreeId: `wt-${index}` })
      store.appendDecision({
        incidentId: record.id,
        toStatus: index % 2 === 0 ? 'duplicate' : 'invalid',
        actor: 'alice',
        reason: 'dismissed'
      })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.scan.rows).toBe(4)
    expect(mine.totals.clusters).toBe(0)
    expect(mine.candidates).toEqual([])
    expect(mine.excluded).toMatchObject({ total: 4 })
  })

  it('counts an unresolvable stable key as unknown, never as a new source (C1)', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 3; index += 1) {
      // No session, worktree or run: a pty exit whose entity cannot be derived.
      seed(store, {
        fingerprint: 'fp-unknown',
        worktreeId: null,
        runId: null,
        agentSessionId: null
      })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.clusters[0]).toMatchObject({
      epochRows: 3,
      stableSources: 0,
      unknownStableSource: 3,
      rules: [],
      singleEntityRecurrence: false
    })
    expect(mine.candidates).toEqual([])
  })

  it('counts known entities alongside unknowns without inflating diversity', () => {
    const { db, store } = fixture()
    seed(store, { fingerprint: 'fp-mixed', worktreeId: 'wt-a' })
    seed(store, { fingerprint: 'fp-mixed', worktreeId: 'wt-b' })
    seed(store, { fingerprint: 'fp-mixed', worktreeId: null, runId: null, agentSessionId: null })
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.clusters[0]).toMatchObject({
      epochRows: 3,
      stableSources: 2,
      unknownStableSource: 1
    })
    expect(mine.clusters[0].rules).toContain(MINE_RULE_REPEAT_FINGERPRINT)
  })

  it('marks single-entity recurrence and keeps it out of candidates and apply (C2)', () => {
    const { db, store } = fixture()
    // Three crashes of one worktree: enough rows, one entity.
    for (let index = 0; index < 3; index += 1) {
      seed(store, {
        fingerprint: 'fp-single',
        worktreeId: 'wt-only',
        exitCause: { kind: 'signaled', signal: 9 }
      })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.clusters[0]).toMatchObject({
      stableSources: 1,
      singleEntityRecurrence: true,
      rules: []
    })
    expect(mine.candidates).toEqual([])
    const applied = applyMineCandidates(store, mine, { target: 'watch' })
    expect(applied.appended).toBe(0)
  })

  it('declares self_report out of mining and says how many were skipped (C5)', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 3; index += 1) {
      seed(store, {
        fingerprint: 'fp-self',
        sourceKind: 'self_report',
        sourceId: `req-${index}`,
        facet: 'report',
        class: 'unknown_state',
        worktreeId: null,
        runId: null
      })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(mine.scan.rows).toBe(3)
    expect(mine.totals.clusters).toBe(0)
    expect(mine.excluded).toEqual({
      total: 3,
      byStatus: [],
      byReason: { terminal: 0, selfReport: 3 }
    })
    expect(mine.candidates).toEqual([])
  })

  it('marks low-information clusters, sorts them last, and caps their candidates (C5)', () => {
    const { db, store } = fixture()
    // A strong cluster plus a generic non_zero_exit cluster that has more rows.
    for (let index = 0; index < 3; index += 1) {
      seed(store, { fingerprint: 'fp-strong', worktreeId: `wt-strong-${index}` })
    }
    for (let index = 0; index < MINE_MAX_LOW_INFORMATION_CANDIDATES + 3; index += 1) {
      seed(store, {
        fingerprint: 'fp-generic',
        class: 'tool_error',
        sourceKind: 'tool_error',
        sourceId: `sess-${index}:turn-1:non_zero_exit:1700000000000`,
        facet: 'tool:non_zero_exit',
        worktreeId: null,
        runId: null,
        exitCause: null
      })
    }
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    const generic = mine.clusters.find((cluster) => cluster.fingerprint === 'fp-generic')!
    expect(generic.lowInformation).toBe(true)
    expect(generic.lowInformationReason).toBe('generic_non_zero_exit')
    // Low-information clusters sort after promotable ones even with more rows.
    expect(mine.clusters[0].fingerprint).toBe('fp-strong')
    expect(mine.totals.lowInformationClusters).toBe(1)
    expect(mine.truncated.lowInformation).toBe(true)
    const genericCandidates = mine.candidates.filter(
      (candidate) => candidate.fingerprint === 'fp-generic'
    )
    expect(genericCandidates).toHaveLength(MINE_MAX_LOW_INFORMATION_CANDIDATES)
    // The strong cluster's candidates are not starved by the noise.
    expect(
      mine.candidates.filter((candidate) => candidate.fingerprint === 'fp-strong')
    ).toHaveLength(3)
  })

  it('never writes: no decisions and no new rows are added by a mining pass', () => {
    const { db, store } = fixture()
    for (let index = 0; index < 3; index += 1) {
      seed(store, { fingerprint: 'fp-read', worktreeId: `wt-${index}` })
    }
    const before = store.countIncidents()
    mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(store.countIncidents()).toBe(before)
    expect(store.listIncidents({ limit: 10 }).incidents.every((row) => row.decisionCount === 0)).toBe(
      true
    )
  })
})

describe('applying miner decisions (M6-2 / M6-C3)', () => {
  function seedCluster(store: IncidentStore, fingerprint: string, rows = 3): string[] {
    const ids: string[] = []
    for (let index = 0; index < rows; index += 1) {
      ids.push(seed(store, { fingerprint, worktreeId: `${fingerprint}-${index}` }).id)
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
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    const applied = applyMineCandidates(store, mine, { target: 'watch', now: () => T0 + 2 * DAY })

    expect(applied).toMatchObject({ attempted: 3, appended: 3, skipped: 0 })
    expect(decisionCount(store)).toBe(3)
    const view = store.getIncident(ids[0])!
    expect(view.effectiveStatus).toBe('watch')
    expect(view.decisions[0]).toMatchObject({ actor: MINER_ACTOR, toStatus: 'watch' })
    expect(view.decisions[0].reason).toContain('rule=repeat_fingerprint')
    expect(view.decisions[0].reason).toContain('count=3')
    expect(view.decisions[0].reason).toContain('stable_sources=3')
    expect(view.decisions[0].reason).toContain('first=')
    expect(view.decisions[0].reason).toContain('last=')
  })

  it('is idempotent: a second apply appends nothing and the decision log does not grow', () => {
    const { db, store } = fixture()
    seedCluster(store, 'fp-idem')
    const first = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    expect(applyMineCandidates(store, first, { target: 'watch' }).appended).toBe(3)
    const afterFirst = decisionCount(store)

    const second = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    // The rows are now `watch`, so they are no longer untriaged candidates at all.
    expect(second.totals.candidates).toBe(0)
    expect(second.candidates).toEqual([])
    const applied = applyMineCandidates(store, second, { target: 'watch' })
    expect(applied).toMatchObject({ attempted: 0, appended: 0, skipped: 0 })
    expect(decisionCount(store)).toBe(afterFirst)
  })

  it('skips a row that is already in the target state even when it is a candidate', () => {
    const { db, store } = fixture()
    const ids = seedCluster(store, 'fp-already')
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    // A hand decision arrives between mining and applying.
    store.appendDecision({ incidentId: ids[0], toStatus: 'watch', actor: 'alice', reason: 'seen' })
    const applied = applyMineCandidates(store, mine, { target: 'watch' })
    expect(applied.appended).toBe(2)
    expect(applied.results.find((result) => result.incidentId === ids[0])?.outcome).toBe(
      'skipped_already_target'
    )
  })

  it('never replaces a human decision made after mining, even a legal transition (C3)', () => {
    const { db, store } = fixture()
    const ids = seedCluster(store, 'fp-human')
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    // R1 confirms the incident between `mine` and `--apply`.
    store.appendDecision({
      incidentId: ids[0],
      toStatus: 'confirmed',
      actor: 'alice',
      reason: 'root cause known'
    })
    const applied = applyMineCandidates(store, mine, { target: 'duplicate' })
    const confirmed = applied.results.find((result) => result.incidentId === ids[0])
    // `confirmed -> duplicate` is a legal transition for a human, and exactly what the miner must not do.
    expect(confirmed?.outcome).toBe('skipped_human_decided')
    expect(store.getIncident(ids[0])?.effectiveStatus).toBe('confirmed')
    expect(applied.appended).toBe(2)
  })

  it('never replaces a watch set by another triage step', () => {
    const { db, store } = fixture()
    const ids = seedCluster(store, 'fp-watch-race')
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    store.appendDecision({ incidentId: ids[1], toStatus: 'watch', actor: 'bob', reason: 'watching' })
    const applied = applyMineCandidates(store, mine, { target: 'needs_archive' })
    expect(
      applied.results.find((result) => result.incidentId === ids[1])?.outcome
    ).toBe('skipped_human_decided')
    expect(store.getIncident(ids[1])?.effectiveStatus).toBe('watch')
  })

  it('never touches a terminal row', () => {
    const { db, store } = fixture()
    const ids = seedCluster(store, 'fp-terminal')
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    store.appendDecision({
      incidentId: ids[0],
      toStatus: 'duplicate',
      actor: 'alice',
      reason: 'same incident'
    })
    const applied = applyMineCandidates(store, mine, { target: 'watch' })
    const duplicate = applied.results.find((result) => result.incidentId === ids[0])
    expect(duplicate?.outcome).toBe('skipped_terminal')
    expect(store.getIncident(ids[0])?.effectiveStatus).toBe('duplicate')
  })

  it('reports a read-only store for every candidate instead of throwing', () => {
    const { db, store } = fixture()
    seedCluster(store, 'fp-readonly')
    const mined = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    const readOnly: MineStore = {
      ...store,
      readOnly: true,
      appendDecision: () => {
        throw new Error('a read-only store must not be written')
      }
    }
    const applied = applyMineCandidates(readOnly, mined, { target: 'watch' })
    expect(applied.appended).toBe(0)
    expect(applied.results.every((result) => result.outcome === 'skipped_read_only')).toBe(true)
  })

  it('writes a reason that carries statistics but never an incident body', () => {
    const { db, store } = fixture()
    seedCluster(store, 'fp-reason')
    const mine = mineWindow(db, store, { now: T0 + DAY, windowMs: 7 * DAY })
    const reason = mineDecisionReason(mine.candidates[0])
    expect(reason).toContain('miner rule=repeat_fingerprint')
    expect(reason).toContain('fingerprint=fp-reason')
    // The seeded summary never appears in the decision text.
    expect(reason).not.toContain('seeded crash')
    expect(reason.length).toBeLessThanOrEqual(500)
  })
})
