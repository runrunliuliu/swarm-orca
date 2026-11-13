/**
 * The miner's bounded write (§10; simplify S3): append-only decisions, idempotency, and the guard that
 * stops it replacing a human decision made after mining (M6-C3).
 *
 * A real incidents database, because the guard lives inside the store's own IMMEDIATE transaction.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MINER_ACTOR } from './incident-mine-rules'
import {
  applyMineCandidates,
  mineDecisionReason,
  type MineStore
} from './incident-mine-apply'
import {
  disposeMineFixtures,
  fixture,
  mineWindow,
  seedIncident as seed
} from './incident-mine-test-support'
import type { IncidentStore } from './incident-store'

const T0 = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

afterEach(() => {
  disposeMineFixtures()
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

