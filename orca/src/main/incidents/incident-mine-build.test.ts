/**
 * The bounded mining read (§10; simplify S3): grouping, entity accounting, exclusion, caps, scan bound.
 *
 * A real incidents database, because the query, the `incident_state` projection and the exclusion
 * arithmetic are what these cases are about.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MINE_MAX_CANDIDATES,
  DEFAULT_MINE_MAX_GROUPS,
  MINE_MAX_LOW_INFORMATION_CANDIDATES,
  MINE_RULE_REPEAT_FINGERPRINT
} from './incident-mine-rules'
import { incidentFingerprint } from './incident-key'
import { applyMineCandidates } from './incident-mine-apply'
import {
  disposeMineFixtures,
  fixture,
  mineWindow,
  seedIncident as seed
} from './incident-mine-test-support'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

afterEach(() => {
  disposeMineFixtures()
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

