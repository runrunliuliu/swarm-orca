import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import {
  bindStartGrantToRun,
  insertStartGrant,
  insertStartGrantRevocation,
  objectiveHashOf,
  readGrantForRun,
  readStartGrant,
  readStartGrantBinding,
  readStartGrantRevocation,
  type StartGrant
} from '../../start-grant-policy'

function db_pragma_foreign_keys(): number {
  const db = new Database(':memory:')
  const value = (db.pragma('foreign_keys', { simple: true }) as number | undefined) ?? 0
  db.close()
  return value
}

function expectRefusal(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected a ${code} refusal`)
}

const minter = {
  terminalHandle: 'term_minter',
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  processIncarnation: 'pty:1',
  launchTokenHash: 'launch-hash',
  hostScope: { kind: 'local', hostId: 'local' }
} as const

function grant(overrides: Partial<StartGrant> = {}): StartGrant {
  const objectiveText = overrides.objectiveText ?? 'review the parser, read only'
  return {
    schemaVersion: 1,
    kind: 'start_grant',
    grantId: '2f6f2b0e-3a4c-4b6f-9a9f-1f0f9c3f5d21',
    objectiveText,
    objectiveHash: objectiveHashOf(objectiveText),
    taskSource: { path: '/tmp/approval.md', sha256: 'a'.repeat(64) },
    authorizationRefs: [],
    maxWorkers: 8,
    repos: [{ repoId: 'repo-1', worktreeIds: null }],
    writableRoots: [],
    spend: { kind: 'none' },
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    minter,
    mintedAt: new Date(Date.now() - 60_000).toISOString(),
    executionAuthorized: false,
    ...overrides
  }
}

describe('start grant persistence', () => {
  const databases: OrchestrationDb[] = []
  const directories: string[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const open = (path: string) => {
    const db = new OrchestrationDb(path)
    databases.push(db)
    return db
  }
  const path = () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-start-grant-'))
    directories.push(directory)
    return join(directory, 'orchestration.db')
  }
  const run = (db: OrchestrationDb, objective = 'granted') =>
    db.createRun({
      objective,
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:22222222-2222-4222-8222-222222222222'
    })

  it('stores the record, its single binding and its revocation, and reads them back after restart', () => {
    const file = path()
    const original = open(file)
    const record = grant()
    insertStartGrant(original, record)
    const target = run(original)
    bindStartGrantToRun(original, {
      grantId: record.grantId,
      runId: target.id,
      boundAuthority: minter
    })
    expect(readStartGrant(original, record.grantId)).toEqual(record)
    expect(readStartGrantBinding(original, { runId: target.id })?.grantId).toBe(record.grantId)
    expect(readGrantForRun(original, target.id)).toEqual(record)
    expect(readStartGrantRevocation(original, record.grantId)).toBeUndefined()
    databases.pop()!.close()

    const reopened = open(file)
    expect(readGrantForRun(reopened, target.id)).toEqual(record)
    expect(readStartGrant(reopened, record.grantId)?.maxWorkers).toBe(8)
  })

  it('refuses every mutation of a grant, a binding and a revocation at the storage boundary', () => {
    const db = open(path())
    const record = grant()
    insertStartGrant(db, record)
    const target = run(db)
    bindStartGrantToRun(db, { grantId: record.grantId, runId: target.id, boundAuthority: minter })
    insertStartGrantRevocation(db, {
      schemaVersion: 1,
      kind: 'start_grant_revocation',
      grantId: record.grantId,
      revokedAt: new Date().toISOString(),
      authority: minter,
      reason: 'owner withdrew the approval',
      executionAuthorized: false
    })

    for (const [table, column] of [
      ['start_grants', 'grant_id'],
      ['start_grant_runs', 'grant_id'],
      ['start_grant_revocations', 'grant_id']
    ] as const) {
      expect(() =>
        db.db.prepare(`UPDATE ${table} SET receipt = '{}' WHERE ${column} = ?`).run(record.grantId)
      ).toThrow('start_grant_immutable')
      expect(() =>
        db.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(record.grantId)
      ).toThrow('start_grant_immutable')
    }
  })

  it('allows one Run per grant and one grant per Run', () => {
    const db = open(path())
    const first = grant()
    const second = grant({ grantId: '9a1d1c7e-0c6b-4a1e-9a3f-5c2b7d4e8f10' })
    insertStartGrant(db, first)
    insertStartGrant(db, second)
    const target = run(db)
    bindStartGrantToRun(db, { grantId: first.grantId, runId: target.id, boundAuthority: minter })
    expect(() =>
      bindStartGrantToRun(db, { grantId: second.grantId, runId: target.id, boundAuthority: minter })
    ).toThrow(/UNIQUE/)
    const other = run(db, 'second')
    expect(() =>
      bindStartGrantToRun(db, { grantId: first.grantId, runId: other.id, boundAuthority: minter })
    ).toThrow(/UNIQUE|PRIMARY/)
  })

  it('refuses a binding whose grant does not exist, on either driver', () => {
    // Both drivers enforce foreign keys (`node:sqlite` defaults enableForeignKeyConstraints to true;
    // the bun driver sets the pragma), so this row cannot be written at all. The behaviour under test
    // is the write-time refusal, not a reader fallback — see the policy unit test for the reader.
    expect(db_pragma_foreign_keys()).toBe(1)
    const db = open(path())
    const target = run(db)
    expect(() =>
      db.db
        .prepare('INSERT INTO start_grant_runs (grant_id, run_id, receipt) VALUES (?, ?, ?)')
        .run(
          '11111111-2222-4333-8444-555555555555',
          target.id,
          JSON.stringify({
            grantId: '11111111-2222-4333-8444-555555555555',
            runId: target.id,
            boundAt: new Date().toISOString(),
            boundAuthority: minter
          })
        )
    ).toThrow(/FOREIGN KEY/)
    expect(readStartGrant(db, '11111111-2222-4333-8444-555555555555')).toBeUndefined()
  })

  it('treats an unparseable record as invalid rather than absent', () => {
    const db = open(path())
    const target = run(db)
    db.db
      .prepare('INSERT INTO start_grants (grant_id, receipt) VALUES (?, ?)')
      .run('11111111-2222-4333-8444-555555555555', '{"maxWorkers":8}')
    db.db
      .prepare('INSERT INTO start_grant_runs (grant_id, run_id, receipt) VALUES (?, ?, ?)')
      .run(
        '11111111-2222-4333-8444-555555555555',
        target.id,
        JSON.stringify({
          grantId: '11111111-2222-4333-8444-555555555555',
          runId: target.id,
          boundAt: new Date().toISOString(),
          boundAuthority: minter
        })
      )
    expectRefusal(() => readGrantForRun(db, target.id), 'start_grant_invalid_record')
    expectRefusal(
      () => readStartGrant(db, '11111111-2222-4333-8444-555555555555'),
      'start_grant_invalid_record'
    )
  })

  it('keeps the binding columns and its receipt in agreement', () => {
    const db = open(path())
    const target = run(db)
    insertStartGrant(db, grant())
    db.db
      .prepare('INSERT INTO start_grant_runs (grant_id, run_id, receipt) VALUES (?, ?, ?)')
      .run(
        grant().grantId,
        target.id,
        JSON.stringify({
          grantId: grant().grantId,
          runId: 'run_something_else',
          boundAt: new Date().toISOString(),
          boundAuthority: minter
        })
      )
    expectRefusal(
      () => readStartGrantBinding(db, { runId: target.id }),
      'start_grant_invalid_record'
    )
  })

  it('creates the three tables on a database that predates them', () => {
    const file = path()
    open(file)
    databases.pop()!.close()
    const raw = new Database(file)
    raw.exec('DROP TABLE start_grant_runs; DROP TABLE start_grant_revocations; DROP TABLE start_grants;')
    raw.close()
    const upgraded = open(file)
    const tables = upgraded.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'start_grant%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(tables).toEqual(['start_grant_revocations', 'start_grant_runs', 'start_grants'])
    const record = grant()
    insertStartGrant(upgraded, record)
    expect(readStartGrant(upgraded, record.grantId)).toEqual(record)
  })
})
