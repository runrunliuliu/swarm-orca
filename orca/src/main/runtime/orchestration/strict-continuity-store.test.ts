import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { COORD, strictCoordinatorHarness } from '../rpc/strict-coordinator-test-fixture'
import {
  sealStrictContinuityDatabase,
  verifyStrictContinuityDatabase,
  assertNoStrictContinuitySeal
} from './strict-continuity-store'
import { strictContinuitySnapshot } from './strict-continuity-snapshot'
import { openStrictContinuityInspection } from './strict-continuity-inspection'

describe('strict continuity database seal', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  let runId: string
  const nowMs = 1_800_000_000_000
  beforeEach(async () => {
    h = strictCoordinatorHarness()
    runId = await h.create()
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })
  const seal = () =>
    sealStrictContinuityDatabase(
      h.db,
      {
        runId,
        sourceRuntimeId: 'before-restart',
        expiresAtMs: nowMs + 60_000
      },
      nowMs
    )
  const expectation = (frozen: ReturnType<typeof seal>) => ({
    runId,
    databaseId: frozen.seal.databaseId,
    sealCanonicalSha256: frozen.sealCanonicalSha256
  })

  it('rejects a damaged pre-seal trigger before changing the database or synchronous mode', () => {
    h.db.db.exec(`DROP TRIGGER trg_continuity_seal_update;
      CREATE TRIGGER trg_continuity_seal_update BEFORE UPDATE ON strict_continuity_seals
      BEGIN SELECT 1; END`)
    const before = strictContinuitySnapshot(h.db)
    const mode = h.db.db.pragma('synchronous')
    expect(seal).toThrow('schema changed')
    expect(strictContinuitySnapshot(h.db)).toBe(before)
    expect(h.db.db.pragma('synchronous')).toEqual(mode)
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_database').all()).toEqual([])
  })

  it('rejects old Runs without a pre-restart seal without creating metadata', () => {
    expect(() =>
      verifyStrictContinuityDatabase(
        h.db,
        {
          runId,
          databaseId: 'old-db',
          sealCanonicalSha256: 'old-pin'
        },
        nowMs
      )
    ).toThrow('No pre-restart seal')
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_database').all()).toEqual([])
  })

  it('is stable, immutable, canonical-pinned and never authorizes execution', () => {
    const before = strictContinuitySnapshot(h.db)
    const frozen = seal()
    expect(frozen.seal.snapshotCanonicalSha256).toBe(before)
    expect(strictContinuitySnapshot(h.db)).toBe(before)
    expect(verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs)).toMatchObject({
      state: 'sealed_not_resumable',
      databaseConsistent: true,
      serverContinuityVerified: false,
      executionAuthorized: false
    })
    expect(() => seal()).toThrow('already exists')
    expect(() => h.db.db.exec('DELETE FROM strict_continuity_seals')).toThrow('immutable')
    expect(() =>
      h.db.db.exec("UPDATE strict_continuity_database SET database_id = 'changed'")
    ).toThrow('immutable')
    expect(() =>
      verifyStrictContinuityDatabase(
        h.db,
        {
          ...expectation(frozen),
          sealCanonicalSha256: '0'.repeat(64)
        },
        nowMs
      )
    ).toThrow('pin mismatch')
    expect(() =>
      verifyStrictContinuityDatabase(
        h.db,
        {
          ...expectation(frozen),
          databaseId: 'different-database'
        },
        nowMs
      )
    ).toThrow('pin mismatch')
  })

  it('rejects expiry and clock rollback but leaves the fence active', () => {
    const frozen = seal()
    for (const time of [nowMs - 1, nowMs + 60_000, Number.NaN]) {
      expect(() => verifyStrictContinuityDatabase(h.db, expectation(frozen), time)).toThrow(
        'expired'
      )
      expect(() => assertNoStrictContinuitySeal(h.db)).toThrow('fenced')
    }
  })

  it('refuses uncertain requests before any seal metadata is committed', () => {
    h.db.beginMutationReceipt({
      callerFingerprint: 'caller',
      requestId: 'uncertain',
      method: 'orchestration.send',
      payloadHash: 'hash'
    })
    expect(seal).toThrow('pending native requests')
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_database').all()).toEqual([])
    expect(h.db.getMutationReceipt('caller', 'uncertain')?.state).toBe('pending')
  })

  it('detects internal database changes outside RPC and never reseals them', () => {
    const frozen = seal()
    h.db.db.prepare('UPDATE runs SET objective = ? WHERE id = ?').run('changed', runId)
    expect(() => verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs)).toThrow(
      'changed'
    )
    expect(seal).toThrow('already exists')
    expect(h.db.getRun(runId)?.coordinator_handle).toBe(COORD)
  })

  it('includes similarly named tables and preserves integer/blob types', () => {
    h.db.db.exec(`CREATE TABLE strict_continuity_extra (value);
      INSERT INTO strict_continuity_extra VALUES (9223372036854775807), (X'0102');`)
    const frozen = seal()
    expect(
      verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs).databaseConsistent
    ).toBe(true)
    h.db.db.exec(
      "UPDATE strict_continuity_extra SET value = '9223372036854775807' WHERE typeof(value) = 'integer'"
    )
    expect(() => verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs)).toThrow(
      'changed'
    )
  })

  it('bounds snapshot work before committing seal metadata', () => {
    h.db.db.exec(`CREATE TABLE continuity_test_rows (value INTEGER);
      WITH RECURSIVE rows(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM rows WHERE value < 100001)
      INSERT INTO continuity_test_rows SELECT value FROM rows;`)
    expect(seal).toThrow('exceeds continuity limits')
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_database').all()).toEqual([])
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_seals').all()).toEqual([])
  })

  it('rolls back identity and seal if commit preparation fails', () => {
    const prepare = h.db.db.prepare.bind(h.db.db)
    const injected = vi.spyOn(h.db.db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT INTO main.strict_continuity_seals')) {
        throw new Error('injected crash')
      }
      return prepare(sql)
    })
    expect(seal).toThrow('injected crash')
    expect(h.db.db.isTransaction).toBe(false)
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_database').all()).toEqual([])
    injected.mockRestore()
    expect(seal().seal.recoveryEpoch).toBe(1)
  })

  it('retains the exact seal after reopen and fences another SQLite connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-continuity-'))
    const file = join(directory, 'orchestration.db')
    let first: OrchestrationDb | undefined
    let second: OrchestrationDb | undefined
    let inspection: ReturnType<typeof openStrictContinuityInspection> | undefined
    try {
      await h.db.db.backup(file)
      first = new OrchestrationDb(file)
      second = new OrchestrationDb(file)
      const frozen = sealStrictContinuityDatabase(
        first,
        {
          runId,
          sourceRuntimeId: 'before',
          expiresAtMs: nowMs + 60_000
        },
        nowMs
      )
      expect(() => assertNoStrictContinuitySeal(second!)).toThrow('fenced')
      first.close()
      first = undefined
      second.close()
      second = undefined
      expect(() => new OrchestrationDb(file)).toThrow('strict_continuity_required')
      inspection = openStrictContinuityInspection(file)
      expect(verifyStrictContinuityDatabase(inspection, expectation(frozen), nowMs).seal).toEqual(
        frozen.seal
      )
      expect(() => inspection!.db.exec('DELETE FROM runs')).toThrow(/readonly|read-only/)
    } finally {
      first?.close()
      second?.close()
      inspection?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    'UPDATE continuity_order SET rowid = 100 WHERE value = 1',
    "UPDATE sqlite_sequence SET seq = 100 WHERE name = 'continuity_sequence'"
  ])('detects changes in implicit database scheduling state: %s', (sql) => {
    h.db.db.exec(`CREATE TABLE continuity_order (value INTEGER);
      INSERT INTO continuity_order VALUES (1), (2);
      CREATE TABLE continuity_sequence (id INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO continuity_sequence DEFAULT VALUES;`)
    const frozen = seal()
    h.db.db.exec(sql)
    expect(() => verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs)).toThrow(
      'changed'
    )
  })

  it('supports WITHOUT ROWID and refuses tables that shadow all rowid aliases', () => {
    h.db.db.exec(`CREATE TABLE continuity_keyed (id TEXT PRIMARY KEY) WITHOUT ROWID;
      INSERT INTO continuity_keyed VALUES ('key');`)
    expect(strictContinuitySnapshot(h.db)).toMatch(/^[a-f0-9]{64}$/)
    h.db.db.exec('CREATE TABLE continuity_shadowed (rowid, _rowid_, oid)')
    expect(seal).toThrow('rowid is shadowed')
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_seals').all()).toEqual([])
  })

  it('does not let temporary tables shadow persistent snapshot contents', () => {
    h.db.db.exec('CREATE TABLE continuity_main (value); INSERT INTO continuity_main VALUES (1)')
    const before = strictContinuitySnapshot(h.db)
    h.db.db.exec('CREATE TEMP TABLE continuity_main (id TEXT PRIMARY KEY) WITHOUT ROWID')
    expect(strictContinuitySnapshot(h.db)).toBe(before)
    h.db.db.exec('UPDATE main.continuity_main SET value = 2')
    expect(strictContinuitySnapshot(h.db)).not.toBe(before)
  })

  it('detects removed continuity immutability triggers', () => {
    const frozen = seal()
    h.db.db.exec('DROP TRIGGER trg_continuity_seal_update')
    expect(() => verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs)).toThrow(
      'changed'
    )
  })

  it('refuses conflicting seal records rather than selecting a convenient one', () => {
    const frozen = seal()
    h.db.db.exec(`INSERT INTO strict_continuity_seals
      SELECT recovery_epoch + 1, run_id, source_runtime_id, expires_at_ms,
        snapshot_canonical_sha256, seal FROM strict_continuity_seals`)
    expect(() => verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs)).toThrow(
      'canonical seal pin mismatch'
    )
  })

  it('does not let temporary metadata bypass the persistent seal fence', () => {
    const frozen = seal()
    h.db.db.exec(`CREATE TEMP TABLE strict_continuity_seals (seal, run_id);
      CREATE TEMP TABLE strict_continuity_database (database_id, singleton);
      CREATE TEMP TABLE mutation_receipts (state);`)
    expect(() => assertNoStrictContinuitySeal(h.db)).toThrow('fenced')
    expect(verifyStrictContinuityDatabase(h.db, expectation(frozen), nowMs).seal).toEqual(
      frozen.seal
    )
  })
})
