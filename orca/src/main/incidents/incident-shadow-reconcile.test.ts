/**
 * Startup replay (§11.2; M2-C1/C3/C4/C6): the acceptance is "kill the main process, restart, the
 * crash row comes back", plus the three properties the review demanded — a seq watermark that
 * survives rotation, capacity refusals that cannot hide a later crash, and a bounded, resumable run.
 */
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'
import { __resetIncidentShadowForTests, appendShadowRecord, shadowFilePath } from './incident-shadow'
import { incidentRecordFromShadowLine, shadowLineSeq } from './incident-shadow-line'
import { reconcileIncidentShadow, recordShadowReconcileFailure } from './incident-shadow-reconcile'
import {
  SHADOW_DROPPED_META,
  SHADOW_REPLAYED_SEQ_META,
  SHADOW_LAST_RUN_LINES_META,
  SHADOW_LAST_RUN_MS_META,
  SHADOW_RECONCILE_FAILURES_META,
  SHADOW_RECONCILE_LAST_ERROR_META,
  readShadowReplayCoverage
} from './incident-shadow-coverage'
import { readMeta } from './incident-store-capacity'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function fixture(limits?: { maxRows: number }): {
  userDataPath: string
  store: IncidentStore
  opened: OpenIncidentsDatabase
} {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-shadow-replay-'))
  directories.push(userDataPath)
  const opened = openIncidentsDatabase(join(userDataPath, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    userDataPath,
    store: createIncidentStore({
      db: opened.db,
      fileSizeBytes: opened.fileSizeBytes,
      ...(limits ? { limits } : {})
    }),
    opened
  }
}

function record(id: string, overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id,
    sourceKind: 'pty_exit',
    sourceId: `ptyinc-${id}`,
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: `ptyinc-${id}`,
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: ['no transcript pointer'] },
    summary: `crash ${id}`,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

function replay(
  ctx: { userDataPath: string; store: IncidentStore; opened: OpenIncidentsDatabase },
  options: {
    budget?: { maxBytes?: number; maxLines?: number }
    now?: () => number
  } = {}
) {
  return reconcileIncidentShadow({
    store: ctx.store,
    db: ctx.opened.db,
    userDataPath: ctx.userDataPath,
    ...options
  })
}

function lastLineSeq(path: string): number {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  return shadowLineSeq(lines.at(-1) ?? '')
}

afterEach(() => {
  __resetIncidentShadowForTests()
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

describe('reconcileIncidentShadow: replay basics', () => {
  it('restores rows whose insert never happened (the crash window)', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    appendShadowRecord(ctx.userDataPath, record('inc_b'))
    expect(ctx.store.countIncidents()).toBe(0)

    const summary = replay(ctx)
    expect(summary).toMatchObject({ replayed: 2, inserted: 2, duplicates: 0, stopped: null })
    expect(ctx.store.countIncidents()).toBe(2)
    expect(ctx.store.getIncident('inc_a')?.exitCause).toEqual({ kind: 'signaled', signal: 9 })
  })

  it('is idempotent: a second replay inserts nothing', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    replay(ctx)
    const second = replay(ctx)
    expect(second).toMatchObject({ replayed: 0, inserted: 0, duplicates: 0 })
    expect(ctx.store.countIncidents()).toBe(1)
  })

  it('resumes after the watermark: only lines above it are handled', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    replay(ctx)
    appendShadowRecord(ctx.userDataPath, record('inc_b'))

    const summary = replay(ctx)
    expect(summary).toMatchObject({ replayed: 1, inserted: 1, duplicates: 0 })
    expect(ctx.store.countIncidents()).toBe(2)
  })

  it('treats an already-inserted row as a duplicate, not an error', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    ctx.store.insertIncident(record('inc_a'))
    expect(replay(ctx)).toMatchObject({ inserted: 0, duplicates: 1 })
    expect(ctx.store.countIncidents()).toBe(1)
  })
})

describe('reconcileIncidentShadow: torn and foreign lines', () => {
  it('leaves an unterminated tail for the next run without consuming it', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    const path = shadowFilePath(ctx.userDataPath)
    const goodSeq = lastLineSeq(path)
    appendFileSync(path, '{"v":2,"id":"inc_partial"')

    const summary = replay(ctx)
    expect(summary).toMatchObject({ replayed: 1, inserted: 1, stopped: null })
    expect(Number(readMeta(ctx.opened.db, SHADOW_REPLAYED_SEQ_META))).toBe(goodSeq)
  })

  it('stops at a complete line it cannot parse, keeps the prefix, and does not repair the file', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    const path = shadowFilePath(ctx.userDataPath)
    const goodSeq = lastLineSeq(path)
    appendFileSync(path, 'not-json\n')
    appendShadowRecord(ctx.userDataPath, record('inc_b'))
    const before = readFileSync(path, 'utf8')

    const summary = replay(ctx)
    expect(summary).toMatchObject({ replayed: 1, inserted: 1, incomplete: true })
    expect(summary.stopped).toMatchObject({ reason: 'unparsable_json', lastSeq: goodSeq })
    expect(ctx.store.countIncidents()).toBe(1)
    // Nothing was truncated or rewritten: the bad line is still there for an operator to see.
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readShadowReplayCoverage(ctx.opened.db)).toMatchObject({
      incomplete: true,
      lastStopReason: 'unparsable_json'
    })
  })

  it('stops on a body version this build does not know (v1 is not silently upgraded)', () => {
    const ctx = fixture()
    appendFileSync(shadowFilePath(ctx.userDataPath), '{"v":1,"seq":1,"id":"inc_old"}\n')
    const summary = replay(ctx)
    expect(summary.stopped).toMatchObject({ reason: 'unsupported_version' })
    expect(summary.inserted).toBe(0)
  })
})

describe('reconcileIncidentShadow: seq watermark vs rotation (M2-C1)', () => {
  it('handles a line appended before a rotation and a line appended after it', () => {
    const ctx = fixture()
    const path = shadowFilePath(ctx.userDataPath)
    // a: written and replayed to EOF.
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    const first = replay(ctx)
    expect(first.inserted).toBe(1)

    // b: appended after the replay, so it is not in the DB yet.
    appendShadowRecord(ctx.userDataPath, record('inc_b'))
    const seqA = readMeta(ctx.opened.db, SHADOW_REPLAYED_SEQ_META)

    // Rotate: base → .1 (b now lives in .1), then a fresh base receives c.
    renameSync(path, `${path}.1`)
    appendShadowRecord(ctx.userDataPath, record('inc_c'))
    expect(lastLineSeq(path)).toBeGreaterThan(Number(seqA))

    const second = replay(ctx)
    // Both b (older file) and c (new base) are above the watermark, so both land.
    expect(second.inserted).toBe(2)
    expect(ctx.store.getIncident('inc_b')).not.toBeNull()
    expect(ctx.store.getIncident('inc_c')).not.toBeNull()
    expect(Number(readMeta(ctx.opened.db, SHADOW_REPLAYED_SEQ_META))).toBeGreaterThanOrEqual(
      lastLineSeq(path)
    )

    // Third run: nothing new, and the watermark did not go backwards.
    const watermarkBefore = Number(readMeta(ctx.opened.db, SHADOW_REPLAYED_SEQ_META))
    const third = replay(ctx)
    expect(third).toMatchObject({ replayed: 0, inserted: 0, duplicates: 0 })
    expect(Number(readMeta(ctx.opened.db, SHADOW_REPLAYED_SEQ_META))).toBe(watermarkBefore)
  })

  it('replays a line whose seq is above the watermark even when every file rotated', () => {
    const ctx = fixture()
    const path = shadowFilePath(ctx.userDataPath)
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    replay(ctx)
    renameSync(path, `${path}.1`)
    appendShadowRecord(ctx.userDataPath, record('inc_b'))

    expect(replay(ctx).inserted).toBe(1)
    expect(ctx.store.getIncident('inc_b')).not.toBeNull()
  })
})

describe('reconcileIncidentShadow: capacity refusals (M2-C3)', () => {
  it('drops a refused noise line durably and still inserts the crash after it', () => {
    const ctx = fixture({ maxRows: 1 })
    // Occupy the single row so the capacity gate refuses the next non-crash insert.
    ctx.store.insertIncident(record('inc_seed'))
    appendShadowRecord(ctx.userDataPath, record('inc_noise', { class: 'no_progress' }))
    appendShadowRecord(ctx.userDataPath, record('inc_crash'))

    const summary = replay(ctx)
    expect(summary).toMatchObject({ dropped: 1, inserted: 1, incomplete: false })
    expect(ctx.store.getIncident('inc_noise')).toBeNull()
    // The crash row is exempt from the limit, so it is not hidden behind the dropped noise.
    expect(ctx.store.getIncident('inc_crash')).not.toBeNull()
    expect(Number(readMeta(ctx.opened.db, SHADOW_DROPPED_META))).toBe(1)
    expect(readShadowReplayCoverage(ctx.opened.db)).toMatchObject({
      dropped: 1,
      lastDroppedReason: 'capacity_limited:rows'
    })
    // Triage can see that something was dropped instead of trusting an empty slot in the list.
    expect(readShadowReplayCoverage(ctx.opened.db).dropped).toBe(1)
  })
})

describe('reconcileIncidentShadow: budget and coverage (M2-C4/C6)', () => {
  it('stops on the line budget with an incomplete marker, then resumes without losing lines', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    appendShadowRecord(ctx.userDataPath, record('inc_b'))
    appendShadowRecord(ctx.userDataPath, record('inc_c'))

    const first = replay(ctx, { budget: { maxLines: 1 } })
    expect(first).toMatchObject({ replayed: 1, inserted: 1, incomplete: true })
    expect(first.stopped?.reason).toBe('budget')
    expect(ctx.store.countIncidents()).toBe(1)
    expect(readShadowReplayCoverage(ctx.opened.db)).toMatchObject({
      incomplete: true,
      lastStopReason: 'budget'
    })

    const watermark = Number(readMeta(ctx.opened.db, SHADOW_REPLAYED_SEQ_META))
    const second = replay(ctx)
    expect(second.inserted).toBe(2)
    expect(second.incomplete).toBe(false)
    expect(Number(readMeta(ctx.opened.db, SHADOW_REPLAYED_SEQ_META))).toBeGreaterThanOrEqual(
      watermark
    )
    expect(ctx.store.countIncidents()).toBe(3)
    expect(readShadowReplayCoverage(ctx.opened.db).incomplete).toBe(false)
  })

  it('records the run cost so a cold start is visible instead of guessed', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_a'))
    const summary = replay(ctx, { now: () => 1_000 })
    expect(Number(readMeta(ctx.opened.db, SHADOW_LAST_RUN_LINES_META))).toBe(summary.replayed)
    expect(Number(readMeta(ctx.opened.db, SHADOW_LAST_RUN_MS_META))).toBeGreaterThanOrEqual(0)
    expect(readShadowReplayCoverage(ctx.opened.db).lastRun).toMatchObject({ lines: 1 })
  })

  it('records a thrown run as incomplete with a failure counter', () => {
    const ctx = fixture()
    recordShadowReconcileFailure(ctx.opened.db, 'disk gone')
    expect(readShadowReplayCoverage(ctx.opened.db)).toMatchObject({
      failures: 1,
      lastError: 'disk gone',
      incomplete: true
    })
    expect(readMeta(ctx.opened.db, SHADOW_RECONCILE_FAILURES_META)).toBe('1')
    expect(readMeta(ctx.opened.db, SHADOW_RECONCILE_LAST_ERROR_META)).toBe('disk gone')
  })
})

describe('incidentRecordFromShadowLine', () => {
  it('rebuilds exactly what the writer put in, including evidence', () => {
    const ctx = fixture()
    appendShadowRecord(ctx.userDataPath, record('inc_roundtrip', {
      evidence: {
        pointers: [{ kind: 'transcript', path: '/tmp/x.jsonl', sha256: 'a'.repeat(64), bytes: 12 }],
        unknownBoundaries: ['b'],
        code: 'tool_schema_mismatch',
        repro: 'run it twice'
      }
    }))
    const line = readFileSync(shadowFilePath(ctx.userDataPath), 'utf8').trimEnd()
    expect(incidentRecordFromShadowLine(line)).toMatchObject({
      id: 'inc_roundtrip',
      evidence: {
        pointers: [{ kind: 'transcript', path: '/tmp/x.jsonl', sha256: 'a'.repeat(64), bytes: 12 }],
        unknownBoundaries: ['b'],
        code: 'tool_schema_mismatch',
        repro: 'run it twice'
      }
    })
  })

  it('throws a typed reason instead of inventing fields', () => {
    expect(() => incidentRecordFromShadowLine('{')).toThrow()
    expect(() => incidentRecordFromShadowLine('{"v":2}')).toThrow(/missing its key|no usable seq/)
    expect(() =>
      incidentRecordFromShadowLine(
        JSON.stringify({
          v: 2,
          seq: 1,
          id: 'i',
          source_kind: 'nope',
          source_id: 's',
          facet: 'f',
          host_id: 'h',
          fingerprint: 'x',
          class: 'crash',
          status: 'untriaged',
          created_at: 1
        })
      )
    ).toThrow(/source_kind/)
  })
})
