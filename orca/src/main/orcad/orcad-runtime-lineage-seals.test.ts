import { chmodSync, copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireOrcadInstanceLock, type OrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { strictCoordinatorHarness } from '../runtime/rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from '../runtime/orchestration/strict-continuity-store'
import { openStrictContinuityInspection } from '../runtime/orchestration/strict-continuity-inspection'
import Database from '../sqlite/sync-database'
import { continuityInventoryFixture } from './orcad-continuity-inventory-test-fixture'

describe.runIf(process.platform === 'linux')('planned Server/database seal chain', () => {
  let root: string
  let h: ReturnType<typeof strictCoordinatorHarness>
  let db: OrchestrationDb | ReturnType<typeof openStrictContinuityInspection>
  let runId: string
  const locks: OrcadInstanceLock[] = []
  const journals: ReturnType<typeof openOrcadRuntimeLineage>[] = []
  const nowMs = 1_800_000_000_000
  function open() {
    const lock = acquireOrcadInstanceLock(root)
    locks.push(lock)
    const journal = openOrcadRuntimeLineage(root, lock)
    journals.push(journal)
    return {
      journal,
      close: () => {
        journal.close()
        lock.release()
      }
    }
  }
  function seal(sourceRuntimeId = 'source') {
    const proof = sealStrictContinuityDatabase(
      db,
      {
        runId,
        sourceRuntimeId,
        expiresAtMs: nowMs + 60_000
      },
      nowMs + 1
    )
    return {
      runId,
      databaseId: proof.seal.databaseId,
      sealCanonicalSha256: proof.sealCanonicalSha256
    }
  }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-lineage-seals-'))
    h = strictCoordinatorHarness()
    runId = await h.create()
    await h.db.db.backup(join(root, 'orchestration.db'))
    db = new OrchestrationDb(join(root, 'orchestration.db'))
  })
  afterEach(() => {
    db.close()
    h.close()
    for (const journal of journals.splice(0)) {
      journal.close()
    }
    for (const lock of locks.splice(0)) {
      lock.release()
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('links an immutable pre-restart seal to the immediate successor without issuing a permit', () => {
    const first = open()
    const source = first.journal.recordBoot('source', nowMs)
    first.journal.recordSourceInventory(continuityInventoryFixture(root), nowMs)
    const expected = seal()
    const recorded = first.journal.recordDatabaseSeal(db, expected, nowMs + 2)
    expect(() => first.journal.recordDatabaseSeal(db, expected, nowMs + 2)).toThrow(
      'already recorded'
    )
    first.close()
    db.close()
    db = openStrictContinuityInspection(join(root, 'orchestration.db'))
    const second = open()
    const target = second.journal.recordBoot('target', nowMs + 3)
    expect(
      second.journal.inspectDatabaseSuccessor(db, expected, source, target, nowMs + 4)
    ).toMatchObject({
      recordCanonicalSha256: recorded.recordCanonicalSha256,
      databaseConsistent: true,
      executionAuthorized: false,
      serverContinuityVerified: false,
      state: 'sealed_not_resumable'
    })
    expect(() =>
      db.db.prepare('UPDATE runs SET objective = ? WHERE id = ?').run('changed', runId)
    ).toThrow(/readonly|read-only/)
    const writer = new Database(join(root, 'orchestration.db'))
    try {
      writer.prepare('UPDATE runs SET objective = ? WHERE id = ?').run('changed', runId)
    } finally {
      writer.close()
    }
    expect(() =>
      second.journal.inspectDatabaseSuccessor(db, expected, source, target, nowMs + 4)
    ).toThrow('changed')
  })

  it('refuses a database-only seal after restart instead of manufacturing its missing Server record', () => {
    const first = open()
    const source = first.journal.recordBoot('source', nowMs)
    const expected = seal()
    first.close()
    const second = open()
    const target = second.journal.recordBoot('target', nowMs + 3)
    expect(() => second.journal.recordDatabaseSeal(db, expected, nowMs + 4)).toThrow(
      'during this Server boot'
    )
    expect(() =>
      second.journal.inspectDatabaseSuccessor(db, expected, source, target, nowMs + 4)
    ).toThrow('no pre-restart Server seal')
  })

  it('rejects a replaced database even if logical identity and contents match', () => {
    const first = open()
    const source = first.journal.recordBoot('source', nowMs)
    first.journal.recordSourceInventory(continuityInventoryFixture(root), nowMs)
    const expected = seal()
    first.journal.recordDatabaseSeal(db, expected, nowMs + 2)
    first.close()
    db.close()
    const file = join(root, 'orchestration.db')
    renameSync(file, join(root, 'original.db'))
    copyFileSync(join(root, 'original.db'), file)
    chmodSync(file, 0o600)
    db = openStrictContinuityInspection(file)
    const second = open()
    const target = second.journal.recordBoot('target', nowMs + 3)
    expect(() =>
      second.journal.inspectDatabaseSuccessor(db, expected, source, target, nowMs + 4)
    ).toThrow('Server/database seal chain changed')
  })

  it('refuses foreign paths, public files, wrong runtime and post-successor clock rollback', async () => {
    const first = open()
    const source = first.journal.recordBoot('source', nowMs)
    first.journal.recordSourceInventory(continuityInventoryFixture(root), nowMs)
    const expected = seal()
    await db.db.backup(join(root, 'other.db'))
    const foreign = openStrictContinuityInspection(join(root, 'other.db'))
    try {
      expect(() => first.journal.recordDatabaseSeal(foreign, expected, nowMs + 2)).toThrow(
        'locked Server database'
      )
    } finally {
      foreign.close()
    }
    chmodSync(join(root, 'orchestration.db'), 0o644)
    expect(() => first.journal.recordDatabaseSeal(db, expected, nowMs + 2)).toThrow('private owned')
    chmodSync(join(root, 'orchestration.db'), 0o600)
    first.journal.recordDatabaseSeal(db, expected, nowMs + 2)
    first.close()
    const second = open()
    const target = second.journal.recordBoot('target', nowMs + 3)
    expect(() =>
      second.journal.inspectDatabaseSuccessor(db, expected, source, target, nowMs + 2)
    ).toThrow('Server/database seal chain changed')
    expect(() =>
      second.journal.inspectDatabaseSuccessor(db, expected, source, target, nowMs + 60_000)
    ).toThrow('expired')
  })
})
