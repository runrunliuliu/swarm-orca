import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { continuityInventoryFixture } from './orcad-continuity-inventory-test-fixture'
import { startOrcadContinuityRecoveryHost } from './orcad-continuity-recovery-host'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { strictCoordinatorHarness } from '../runtime/rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from '../runtime/orchestration/strict-continuity-store'
import Database from '../sqlite/sync-database'
import * as files from './orcad-continuity-file-inventory'

describe.runIf(process.platform === 'linux')('source inventory in planned continuity', () => {
  let root: string
  let scope: ReturnType<typeof continuityInventoryFixture>
  let db: OrchestrationDb
  let databaseClosed: boolean
  let runId: string
  const now = Date.now() - 1000
  const closers: (() => void)[] = []
  function closeDatabase() {
    if (!databaseClosed) {
      db.close()
      databaseClosed = true
    }
  }
  function open() {
    const lock = acquireOrcadInstanceLock(root)
    const journal = openOrcadRuntimeLineage(root, lock)
    const close = () => {
      journal.close()
      lock.release()
    }
    closers.push(close)
    return { journal, close }
  }
  function seal(sourceRuntimeId: string) {
    const proof = sealStrictContinuityDatabase(
      db,
      { runId, sourceRuntimeId, expiresAtMs: now + 60_000 },
      now + 10
    )
    return {
      runId,
      databaseId: proof.seal.databaseId,
      sealCanonicalSha256: proof.sealCanonicalSha256
    }
  }
  function rows(table: 'boots' | 'source_inventories' | 'database_seals') {
    const reader = new Database(join(root, 'strict-runtime-lineage.db'), { readonly: true })
    try {
      return reader.prepare(`SELECT * FROM ${table}`).all()
    } finally {
      reader.close()
    }
  }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-source-inventory-'))
    scope = continuityInventoryFixture(root)
    const harness = strictCoordinatorHarness()
    try {
      runId = await harness.create()
      await harness.db.db.backup(join(root, 'orchestration.db'))
    } finally {
      harness.close()
    }
    db = new OrchestrationDb(join(root, 'orchestration.db'))
    databaseClosed = false
  })
  afterEach(() => {
    vi.restoreAllMocks()
    closeDatabase()
    for (const close of closers.splice(0).toReversed()) {
      close()
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('requires a source inventory before recording the database association', () => {
    const { journal } = open()
    journal.recordBoot('source', now)
    const expected = seal('source')
    expect(() => journal.recordDatabaseSeal(db, expected, now + 20)).toThrow(
      'no pre-restart source inventory'
    )
    expect(rows('database_seals')).toEqual([])
    journal.recordSourceInventory(scope, now + 11)
    expect(() => journal.recordDatabaseSeal(db, expected, now + 20)).toThrow('must precede')
    expect(rows('database_seals')).toEqual([])
  })

  it('makes source records immutable and never trusts caller edits to the returned inventory', () => {
    const { journal } = open()
    journal.recordBoot('source', now)
    const record = journal.recordSourceInventory(scope, now)
    record.record.scope.files[0] = 'changed'
    expect(() => journal.recordSourceInventory(scope, now)).toThrow('already recorded')
    const expected = seal('source')
    expect(
      journal.recordDatabaseSeal(db, expected, now + 20).record.sourceInventoryCanonicalSha256
    ).toBe(record.recordCanonicalSha256)
    const writer = new Database(join(root, 'strict-runtime-lineage.db'))
    try {
      expect(() => writer.exec('DELETE FROM source_inventories')).toThrow('lineage_immutable')
      expect(() => writer.exec("UPDATE source_inventories SET body='{}'")).toThrow(
        'lineage_immutable'
      )
    } finally {
      writer.close()
    }
  })

  it('rolls back source registration on a second observation mismatch', () => {
    const { journal } = open()
    journal.recordBoot('source', now)
    const read = files.continuityFileInventory
    vi.spyOn(files, 'continuityFileInventory')
      .mockImplementationOnce(read)
      .mockImplementationOnce((input) => {
        writeFileSync(join(scope.monitorStateRoot, 'state.json'), '{"drift":true}')
        return read(input)
      })
    expect(() => journal.recordSourceInventory(scope, now)).toThrow('changed during registration')
    expect(rows('source_inventories')).toEqual([])
    vi.restoreAllMocks()
    expect(() => journal.recordSourceInventory(scope, now)).not.toThrow()
  })

  it.each(['state.json', 'STOP', 'head.json'])(
    'rejects %s drift before admitting a successor',
    (name) => {
      const first = open()
      const source = first.journal.recordBoot('source', now)
      first.journal.recordSourceInventory(scope, now)
      const expected = seal('source')
      first.journal.recordDatabaseSeal(db, expected, now + 20)
      first.close()
      closeDatabase()
      const before = rows('boots')
      writeFileSync(
        name === 'head.json' ? scope.files[0] : join(scope.monitorStateRoot, name),
        'changed',
        { mode: 0o600 }
      )
      expect(() => startOrcadContinuityRecoveryHost(root, { source, seal: expected })).toThrow(
        'admission failed'
      )
      expect(rows('boots')).toEqual(before)
    }
  )

  it('rechecks inventory on every inspection and prevents late source adoption', () => {
    const first = open()
    const source = first.journal.recordBoot('source', now)
    first.journal.recordSourceInventory(scope, now)
    const expected = seal('source')
    first.journal.recordDatabaseSeal(db, expected, now + 20)
    first.close()
    closeDatabase()
    const host = startOrcadContinuityRecoveryHost(root, { source, seal: expected })
    closers.push(host.close)
    expect(host.inspect().sourceInventory.record.scope).toEqual(scope)
    writeFileSync(scope.files[0], 'changed')
    expect(() => host.inspect()).toThrow('source files changed')
    host.close()
    const second = open()
    expect(() => second.journal.recordSourceInventory(scope)).toThrow(
      'current Server boot required'
    )
  })
})
