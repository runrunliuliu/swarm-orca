import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { strictCoordinatorHarness } from '../runtime/rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from '../runtime/orchestration/strict-continuity-store'
import { openStrictContinuityInspection } from '../runtime/orchestration/strict-continuity-inspection'
import {
  acquireProfileStateRuntimeAdmission,
  acquireProfileStateMaintenance
} from '../persistence/profile-state/profile-state-access'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import { startOrcadContinuityRecoveryHost } from './orcad-continuity-recovery-host'
import * as hostIdentity from '../persistence/profile-state/profile-state-access-identity'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { continuityInventoryFixture } from './orcad-continuity-inventory-test-fixture'

describe.runIf(process.platform === 'linux')('isolated continuity inspection host', () => {
  let root: string
  let pins: Parameters<typeof startOrcadContinuityRecoveryHost>[1]
  let host: ReturnType<typeof startOrcadContinuityRecoveryHost> | undefined
  let runId: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-recovery-host-'))
    const harness = strictCoordinatorHarness()
    try {
      runId = await harness.create()
      await harness.db.db.backup(join(root, 'orchestration.db'))
    } finally {
      harness.close()
    }
    const instance = acquireOrcadInstanceLock(root)
    const journal = openOrcadRuntimeLineage(root, instance)
    const db = new OrchestrationDb(join(root, 'orchestration.db'))
    try {
      const at = Date.now() - 1000
      const source = journal.recordBoot('source-runtime', at)
      journal.recordSourceInventory(continuityInventoryFixture(root), at)
      const sealed = sealStrictContinuityDatabase(
        db,
        { runId, sourceRuntimeId: source.runtimeId, expiresAtMs: at + 60_000 },
        at + 1
      )
      pins = {
        source,
        seal: {
          runId,
          databaseId: sealed.seal.databaseId,
          sealCanonicalSha256: sealed.sealCanonicalSha256
        }
      }
      journal.recordDatabaseSeal(db, pins.seal, at + 2)
    } finally {
      db.close()
      journal.close()
      instance.release()
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    host?.close()
    host = undefined
    rmSync(root, { recursive: true, force: true })
  })

  function boots() {
    return journalDbRows('SELECT body FROM boots ORDER BY epoch')
  }

  function journalDbRows(sql: string) {
    const db = new Database(join(root, 'strict-runtime-lineage.db'), { readonly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }

  it('admits only read-only inspection with a Server-generated successor ID and no execution permit', () => {
    const before = readFileSync(join(root, 'orchestration.db'))
    host = startOrcadContinuityRecoveryHost(root, pins)
    expect(Object.keys(host).sort()).toEqual(['close', 'inspect', 'mode'])
    expect(host.mode).toBe('continuity-inspection-only')
    const proof = host.inspect()
    expect(proof).toMatchObject({
      databaseConsistent: true,
      executionAuthorized: false,
      serverContinuityVerified: false,
      state: 'sealed_not_resumable',
      source: pins.source,
      target: { epoch: pins.source.epoch + 1, serverId: pins.source.serverId }
    })
    expect(proof.target.runtimeId).not.toBe(pins.source.runtimeId)
    expect(boots()).toHaveLength(2)
    expect(readFileSync(join(root, 'orchestration.db'))).toEqual(before)
    expect(() => new OrchestrationDb(join(root, 'orchestration.db'))).toThrow(
      'strict_continuity_required'
    )
    expect(existsSync(join(root, 'profiles'))).toBe(false)
    expect(existsSync(join(root, 'daemon'))).toBe(false)
    expect(() => acquireOrcadInstanceLock(root)).toThrow('already')
    expect(() => acquireProfileStateRuntimeAdmission(root)).toThrow()
    expect(() => acquireProfileStateMaintenance(root)).toThrow()
  })

  it('does not trust caller-mutable pins or returned proof as active state', () => {
    host = startOrcadContinuityRecoveryHost(root, pins)
    const first = host.inspect()
    const expectedTarget = structuredClone(first.target)
    first.target.runtimeId = 'changed-by-reader'
    first.source.runtimeId = 'changed-by-reader'
    pins.seal.runId = 'changed-by-caller'
    pins.source.runtimeId = 'changed-by-caller'
    expect(host.inspect().target).toEqual(expectedTarget)
    expect(host.inspect().source.runtimeId).toBe('source-runtime')
  })

  it('rolls back failed successor admission and lets corrected pins use the same immediate successor slot', () => {
    const before = boots()
    expect(() =>
      startOrcadContinuityRecoveryHost(root, {
        ...pins,
        seal: { ...pins.seal, sealCanonicalSha256: '0'.repeat(64) }
      })
    ).toThrow('Recovery inspection admission failed')
    expect(boots()).toEqual(before)
    host = startOrcadContinuityRecoveryHost(root, pins)
    expect(host.inspect().target.epoch).toBe(2)
  })

  it('refuses a competing profile writer before registering any successor', () => {
    const writer = acquireProfileStateRuntimeAdmission(root)
    const before = boots()
    try {
      expect(() => startOrcadContinuityRecoveryHost(root, pins)).toThrow('admission failed')
      expect(boots()).toEqual(before)
    } finally {
      writer.release()
    }
    host = startOrcadContinuityRecoveryHost(root, pins)
    expect(host.inspect().target.epoch).toBe(2)
  })

  it('reopens inspection-only with a fresh generation, without granting execution or replacing history', () => {
    host = startOrcadContinuityRecoveryHost(root, pins)
    const first = host.inspect()
    host.close()
    host.close()
    expect(() => host?.inspect()).toThrow('host is closed')
    const before = boots()
    host = startOrcadContinuityRecoveryHost(root, pins)
    const second = host.inspect()
    expect(second).toMatchObject({
      source: first.source,
      executionAuthorized: false,
      serverContinuityVerified: false,
      admission: { admissionGeneration: 2, previousCanonicalSha256: first.admissionCanonicalSha256 }
    })
    expect(second.target.runtimeId).not.toBe(first.target.runtimeId)
    expect(second.target.epoch).toBe(3)
    expect(boots().slice(0, 2)).toEqual(before)
  })

  it('does not treat an ordinary intervening boot as an inspection-only predecessor', () => {
    const instance = acquireOrcadInstanceLock(root)
    const journal = openOrcadRuntimeLineage(root, instance)
    try {
      journal.recordBoot('ordinary-intervening-runtime')
    } finally {
      journal.close()
      instance.release()
    }
    const before = boots()
    expect(() => startOrcadContinuityRecoveryHost(root, pins)).toThrow('admission failed')
    expect(boots()).toEqual(before)
  })

  it('rolls back a recovery-only restart when its original seal or host identity no longer matches', () => {
    host = startOrcadContinuityRecoveryHost(root, pins)
    host.close()
    const before = boots()
    expect(() =>
      startOrcadContinuityRecoveryHost(root, {
        ...pins,
        seal: { ...pins.seal, sealCanonicalSha256: '0'.repeat(64) }
      })
    ).toThrow('admission failed')
    vi.spyOn(hostIdentity, 'profileStateAccessBootIdentity').mockReturnValue('different-kernel')
    expect(() => startOrcadContinuityRecoveryHost(root, pins)).toThrow('admission failed')
    expect(boots()).toEqual(before)
  })

  it('refuses a changed recovery ancestry even when its stored digest was recomputed', () => {
    host = startOrcadContinuityRecoveryHost(root, pins)
    const proof = host.inspect()
    host.close()
    const db = new Database(join(root, 'strict-runtime-lineage.db'))
    try {
      const trigger = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name = 'immutable_recovery_inspections_update'"
        )
        .get()
      if (typeof trigger?.sql !== 'string') {
        throw new Error('Missing fixture trigger')
      }
      db.exec('DROP TRIGGER immutable_recovery_inspections_update')
      const changed = { ...proof.admission, previousCanonicalSha256: '0'.repeat(64) }
      db.prepare('UPDATE recovery_inspections SET body = ?, canonical_sha256 = ?').run(
        JSON.stringify(changed),
        hashCanonical(changed)
      )
      db.exec(trigger.sql)
    } finally {
      db.close()
    }
    const before = boots()
    expect(() => startOrcadContinuityRecoveryHost(root, pins)).toThrow('admission failed')
    expect(boots()).toEqual(before)
  })

  it('rolls back boot and admission together when the final maintenance check fails', () => {
    const instance = acquireOrcadInstanceLock(root)
    const journal = openOrcadRuntimeLineage(root, instance)
    const before = boots()
    const assertAdmission = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('fixture: maintenance ownership lost')
      })
    try {
      const inspection = openStrictContinuityInspection(join(root, 'orchestration.db'))
      try {
        expect(() =>
          journal.recordRecoveryInspection(
            inspection,
            pins.seal,
            pins.source,
            'aborted-target',
            Date.now(),
            assertAdmission
          )
        ).toThrow('maintenance ownership lost')
      } finally {
        inspection.close()
      }
      expect(boots()).toEqual(before)
      expect(journalDbRows('SELECT * FROM recovery_inspections')).toEqual([])
    } finally {
      journal.close()
      instance.release()
    }
    host = startOrcadContinuityRecoveryHost(root, pins)
    expect(host.inspect().admission.admissionGeneration).toBe(1)
  })

  it('keeps the original seal deadline across inspection-only restarts', () => {
    host = startOrcadContinuityRecoveryHost(root, pins)
    host.close()
    const before = boots()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    expect(() => startOrcadContinuityRecoveryHost(root, pins)).toThrow('admission failed')
    expect(boots()).toEqual(before)
  })

  it('revalidates the database on each inspection, including writes outside the participating locks', () => {
    host = startOrcadContinuityRecoveryHost(root, pins)
    const db = new Database(join(root, 'orchestration.db'))
    try {
      db.prepare('UPDATE runs SET objective = ? WHERE id = ?').run('drift', runId)
    } finally {
      db.close()
    }
    expect(() => host?.inspect()).toThrow('Database changed after sealing')
  })

  it('does not synthesize a missing pre-restart journal', () => {
    const empty = mkdtempSync(join(tmpdir(), 'orca-recovery-missing-'))
    const instance = acquireOrcadInstanceLock(empty)
    try {
      expect(() => openOrcadRuntimeLineage(empty, instance, { existingOnly: true })).toThrow(
        'journal is missing'
      )
      expect(existsSync(join(empty, 'strict-runtime-lineage.db'))).toBe(false)
    } finally {
      instance.release()
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('does not recreate missing immutability constraints in a historical journal', () => {
    const file = join(root, 'strict-runtime-lineage.db')
    const db = new Database(file)
    try {
      db.exec('DROP TRIGGER immutable_boot_delete')
    } finally {
      db.close()
    }
    const before = boots()
    expect(() => startOrcadContinuityRecoveryHost(root, pins)).toThrow('admission failed')
    expect(boots()).toEqual(before)
    const check = new Database(file, { readonly: true })
    try {
      expect(
        check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'immutable_boot_delete'").get()
      ).toBeUndefined()
    } finally {
      check.close()
    }
  })
})
