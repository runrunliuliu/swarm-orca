/**
 * Startup replay (§11.2): the acceptance is "kill the main process, restart, the crash row comes
 * back". These tests simulate the kill by writing shadow lines whose rows were never inserted, then
 * running reconcile on a real database file.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'
import { __resetIncidentShadowForTests, appendShadowRecord, shadowFilePath } from './incident-shadow'
import {
  SHADOW_RECONCILE_FAILURES_META,
  SHADOW_RECONCILE_LAST_ERROR_META,
  SHADOW_WATERMARK_FILE_META,
  SHADOW_WATERMARK_OFFSET_META,
  reconcileIncidentShadow,
  recordShadowReconcileFailure
} from './incident-shadow-reconcile'
import { incidentRecordFromShadowLine } from './incident-shadow-line'
import { readMeta } from './incident-store-capacity'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function fixture(): { userDataPath: string; store: IncidentStore; opened: OpenIncidentsDatabase } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-shadow-replay-'))
  directories.push(userDataPath)
  const opened = openIncidentsDatabase(join(userDataPath, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    userDataPath,
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }),
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

describe('reconcileIncidentShadow', () => {
  it('restores rows whose insert never happened (the crash window)', () => {
    const { userDataPath, store } = fixture()
    appendShadowRecord(userDataPath, record('inc_a'))
    appendShadowRecord(userDataPath, record('inc_b'))
    expect(store.countIncidents()).toBe(0)

    const summary = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(summary).toMatchObject({ replayed: 2, inserted: 2, duplicates: 0, stopped: null })
    expect(store.countIncidents()).toBe(2)
    const restored = store.getIncident('inc_a')!
    expect(restored.exitCause).toEqual({ kind: 'signaled', signal: 9 })
    expect(restored.status).toBe('untriaged')
  })

  it('is idempotent: a second replay inserts nothing and does not rescan replayed lines', () => {
    const { userDataPath, store } = fixture()
    appendShadowRecord(userDataPath, record('inc_a'))
    reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })

    // The watermark is at EOF, so this run sees no lines at all — proving it did not re-feed them
    // (a rescan would report them as duplicates).
    const second = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(second).toMatchObject({ replayed: 0, inserted: 0, duplicates: 0 })
    expect(store.countIncidents()).toBe(1)
  })

  it('resumes after the watermark: only new lines are applied', () => {
    const { userDataPath, store } = fixture()
    appendShadowRecord(userDataPath, record('inc_a'))
    reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    appendShadowRecord(userDataPath, record('inc_b'))

    const summary = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(summary).toMatchObject({ replayed: 1, inserted: 1, duplicates: 0 })
    expect(store.countIncidents()).toBe(2)
  })

  it('replays a duplicate when the row was already inserted before the crash', () => {
    const { userDataPath, store } = fixture()
    // Both written: the process died after the insert but before… nothing. Replay must still be safe.
    appendShadowRecord(userDataPath, record('inc_a'))
    store.insertIncident(record('inc_a'))
    const summary = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(summary).toMatchObject({ inserted: 0, duplicates: 1 })
    expect(store.countIncidents()).toBe(1)
  })

  it('leaves a torn (unterminated) tail for the next run without consuming it', () => {
    const { userDataPath, store } = fixture()
    appendShadowRecord(userDataPath, record('inc_a'))
    const path = shadowFilePath(userDataPath)
    const goodLine = readFileSync(path, 'utf8')
    appendFileSync(path, '{"v":1,"id":"inc_partial"')

    const summary = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(summary).toMatchObject({ replayed: 1, inserted: 1, stopped: null })
    const offset = Number(readMeta(databases[0].db, SHADOW_WATERMARK_OFFSET_META))
    expect(offset).toBe(Buffer.byteLength(goodLine, 'utf8'))

    // The writer finishes the line (a later append); the next run picks it up from that offset.
    appendFileSync(
      path,
      `,"source_kind":"pty_exit","source_id":"ptyinc-inc_partial","facet":"exit",` +
        `"host_id":"host-a","worktree_id":null,"run_id":null,"task_id":null,"dispatch_id":null,` +
        `"agent_session_id":null,"pty_incarnation_id":null,"class":"crash","status":"untriaged",` +
        `"exit_cause":null,"fingerprint":"${'f'.repeat(64)}","evidence":{"pointers":[],` +
        `"unknownBoundaries":[]},"summary":"late","created_at":1}\n`
    )
    const after = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(after).toMatchObject({ replayed: 1, inserted: 1 })
  })

  it('stops at a complete line it cannot parse, keeps the prefix, and does not repair the file', () => {
    const { userDataPath, store } = fixture()
    appendShadowRecord(userDataPath, record('inc_a'))
    const path = shadowFilePath(userDataPath)
    appendFileSync(path, 'not-json\n')
    appendShadowRecord(userDataPath, record('inc_b'))
    const before = readFileSync(path, 'utf8')

    const summary = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(summary).toMatchObject({ replayed: 1, inserted: 1 })
    expect(summary.stopped).toMatchObject({ reason: 'unparsable_json' })
    expect(store.countIncidents()).toBe(1)
    // Nothing was truncated or rewritten: the bad line is still there for an operator to see.
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(readMeta(databases[0].db, SHADOW_WATERMARK_FILE_META)).toBe('shadow.ndjson')
  })

  it('stops on a body version this build does not know', () => {
    const { userDataPath, store } = fixture()
    appendFileSync(shadowFilePath(userDataPath), '{"v":2,"id":"inc_future"}\n')
    const summary = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(summary.stopped).toMatchObject({ reason: 'unsupported_version' })
    expect(summary.inserted).toBe(0)
  })

  it('replays everything when the watermark file rotated away', () => {
    const { userDataPath, store } = fixture()
    appendShadowRecord(userDataPath, record('inc_a'))
    reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    // Simulate rotation: the replayed file is renamed to `.1` and a fresh base begins.
    const path = shadowFilePath(userDataPath)
    appendFileSync(path, '')
    // Point the watermark at a file that no longer exists.
    databases[0].db
      .prepare("UPDATE incident_store_meta SET value = 'shadow.ndjson.9' WHERE key = ?")
      .run(SHADOW_WATERMARK_FILE_META)

    const summary = reconcileIncidentShadow({ store, db: databases[0].db, userDataPath })
    expect(summary.inserted).toBe(0)
    expect(summary.duplicates).toBe(1)
    expect(store.countIncidents()).toBe(1)
  })
})

describe('incidentRecordFromShadowLine', () => {
  it('rebuilds exactly what the writer put in, including evidence', () => {
    const original = record('inc_roundtrip', {
      evidence: {
        pointers: [{ kind: 'transcript', path: '/tmp/x.jsonl', sha256: 'a'.repeat(64), bytes: 12 }],
        unknownBoundaries: ['b'],
        code: 'tool_schema_mismatch',
        repro: 'run it twice'
      }
    })
    const text = JSON.stringify({
      v: 1,
      seq: 1,
      id: original.id,
      source_kind: original.sourceKind,
      source_id: original.sourceId,
      facet: original.facet,
      host_id: original.hostId,
      worktree_id: original.worktreeId,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      agent_session_id: null,
      pty_incarnation_id: original.ptyIncarnationId,
      class: original.class,
      status: original.status,
      exit_cause: original.exitCause,
      fingerprint: original.fingerprint,
      evidence: original.evidence,
      summary: original.summary,
      created_at: original.createdAt
    })
    expect(incidentRecordFromShadowLine(text)).toEqual(original)
  })

  it('throws a typed reason instead of inventing fields', () => {
    expect(() => incidentRecordFromShadowLine('{')).toThrow()
    expect(() => incidentRecordFromShadowLine('{"v":1}')).toThrow(/missing its key/)
    expect(() =>
      incidentRecordFromShadowLine(
        JSON.stringify({ v: 1, id: 'i', source_kind: 'nope', source_id: 's', facet: 'f', host_id: 'h', fingerprint: 'x', class: 'crash', status: 'untriaged', created_at: 1 })
      )
    ).toThrow(/source_kind/)
  })
})

describe('recordShadowReconcileFailure', () => {
  it('counts failures and keeps the last message for the read model', () => {
    const { opened } = fixture()
    recordShadowReconcileFailure(opened.db, 'disk gone')
    recordShadowReconcileFailure(opened.db, 'disk still gone')
    expect(readMeta(opened.db, SHADOW_RECONCILE_FAILURES_META)).toBe('2')
    expect(readMeta(opened.db, SHADOW_RECONCILE_LAST_ERROR_META)).toBe('disk still gone')
  })
})
