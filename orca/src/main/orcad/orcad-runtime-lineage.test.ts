import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireOrcadInstanceLock, type OrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import * as hostIdentity from '../persistence/profile-state/profile-state-access-identity'
import Database from '../sqlite/sync-database'

describe.runIf(process.platform === 'linux')(
  'local Server boot lineage (not a resume permit)',
  () => {
    const roots: string[] = []
    const locks: OrcadInstanceLock[] = []
    const journals: ReturnType<typeof openOrcadRuntimeLineage>[] = []
    const root = () => {
      const path = mkdtempSync(join(tmpdir(), 'orcad-lineage-'))
      roots.push(path)
      return path
    }
    const open = (path: string) => {
      const lock = acquireOrcadInstanceLock(path)
      locks.push(lock)
      const journal = openOrcadRuntimeLineage(path, lock)
      journals.push(journal)
      return {
        lock,
        journal,
        close: () => {
          journal.close()
          lock.release()
        }
      }
    }
    afterEach(() => {
      for (const journal of journals.splice(0)) {
        journal.close()
      }
      for (const lock of locks.splice(0)) {
        lock.release()
      }
      for (const path of roots.splice(0)) {
        rmSync(path, { recursive: true, force: true })
      }
      vi.restoreAllMocks()
    })

    it('keeps the Server ID and appends a new runtime epoch without granting execution', () => {
      const path = root()
      const first = open(path)
      const before = first.journal.recordBoot('runtime-before')
      first.close()
      const second = open(path)
      const after = second.journal.recordBoot('runtime-after')
      expect(after.serverId).toBe(before.serverId)
      expect(after.epoch).toBe(before.epoch + 1)
      expect(second.journal.inspectSuccessor(before, after)).toMatchObject({
        proofScope: 'local-server-boot-chain-only',
        executionAuthorized: false,
        serverContinuityVerified: false
      })
    })

    it('invalidates an old target immediately after lock succession, before a new boot is recorded', () => {
      const path = root()
      const first = open(path)
      const before = first.journal.recordBoot('runtime-before')
      first.close()
      const second = open(path)
      const after = second.journal.recordBoot('runtime-after')
      second.close()
      const third = open(path)
      expect(() => third.journal.inspectSuccessor(before, after)).toThrow(
        'immediate same-boot successor'
      )
      const latest = third.journal.recordBoot('runtime-latest')
      expect(() => third.journal.inspectSuccessor(before, latest)).toThrow(
        'immediate same-boot successor'
      )
    })

    it('refuses forged/released/replaced locks and a concurrent Server', () => {
      const path = root()
      const first = open(path)
      const forged = { ...first.lock }
      expect(() => openOrcadRuntimeLineage(path, forged)).toThrow('acquired_instance_lock')
      expect(() => acquireOrcadInstanceLock(path)).toThrow('already')
      const record = JSON.parse(readFileSync(first.lock.path, 'utf8'))
      writeFileSync(first.lock.path, JSON.stringify({ ...record, nonce: 'replacement' }))
      expect(() => first.journal.recordBoot('runtime')).toThrow('instance_lock_lost')
      writeFileSync(first.lock.path, JSON.stringify(record))
      first.lock.release()
      expect(() => first.journal.recordBoot('runtime')).toThrow('instance_lock_lost')
    })

    it('rejects an ordinary clone instead of adopting its UUID', () => {
      const original = root()
      const first = open(original)
      first.journal.recordBoot('runtime')
      first.close()
      const copied = root()
      copyFileSync(
        join(original, 'strict-runtime-lineage.db'),
        join(copied, 'strict-runtime-lineage.db')
      )
      expect(() => open(copied)).toThrow('journal object changed')
    })

    it('keeps the acquired lock and its public identity immutable', () => {
      const first = open(root())
      expect(Reflect.set(first.lock.record, 'nonce', 'replacement')).toBe(false)
      expect(
        Reflect.set(first.lock, 'record', { ...first.lock.record, nonce: 'replacement' })
      ).toBe(false)
      writeFileSync(first.lock.path, JSON.stringify({ ...first.lock.record, nonce: 'replacement' }))
      expect(() => first.journal.recordBoot('runtime')).toThrow('instance_lock_lost')
      first.lock.release()
      expect(JSON.parse(readFileSync(first.lock.path, 'utf8')).nonce).toBe('replacement')
    })

    it('refuses broken ancestral history even when the current boot still has a matching hash', () => {
      const path = root()
      const first = open(path)
      const source = first.journal.recordBoot('source')
      first.close()
      const second = open(path)
      const target = second.journal.recordBoot('target')
      const writer = new Database(join(path, 'strict-runtime-lineage.db'))
      try {
        const trigger = writer
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'immutable_boot_delete'")
          .get()
        if (typeof trigger?.sql !== 'string') {
          throw new Error('Missing fixture trigger')
        }
        writer.exec('DROP TRIGGER immutable_boot_delete; DELETE FROM boots WHERE epoch = 1')
        writer.exec(trigger.sql)
      } finally {
        writer.close()
      }
      expect(() => second.journal.inspectSuccessor(source, target)).toThrow('ancestry mismatch')
    })

    it('refuses missing host identity, changed boot, clock rollback and duplicate runtime', () => {
      const path = root()
      const first = open(path)
      const before = first.journal.recordBoot('runtime-before')
      expect(() => first.journal.recordBoot('runtime-before')).toThrow()
      expect(() => first.journal.recordBoot('another-runtime')).toThrow('already recorded')
      first.close()
      vi.spyOn(hostIdentity, 'profileStateAccessBootIdentity').mockReturnValue('different-boot')
      const second = open(path)
      expect(() => second.journal.recordBoot('clock-back', before.startedAtMs - 1)).toThrow('clock')
      const after = second.journal.recordBoot('runtime-after')
      expect(() => second.journal.inspectSuccessor(before, after)).toThrow(
        'immediate same-boot successor'
      )
      second.close()
      vi.spyOn(hostIdentity, 'profileStateAccessMachineIdentity').mockReturnValue(null)
      expect(() => open(path)).toThrow('planned-restart identity')
    })
  }
)
