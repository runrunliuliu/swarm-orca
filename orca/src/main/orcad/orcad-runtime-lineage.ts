import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import Database from '../sqlite/sync-database'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import { assertOrcadInstanceLock, type OrcadInstanceLock } from './orcad-instance-lock'
import { runtimeLineageHostIdentity } from './orcad-runtime-lineage-host'
import { continuityFileIdentity as identity } from './orcad-continuity-file-identity'
import { runtimeLineageSeals } from './orcad-runtime-lineage-seals'
import { runtimeLineageRecovery } from './orcad-runtime-lineage-recovery'
import { runtimeLineageInventory } from './orcad-runtime-lineage-inventory'
import { initializeRuntimeLineageSchema } from './orcad-runtime-lineage-schema'
import { plannedRestartJournal } from './orcad-planned-restart'
import type {
  StrictContinuityInspection,
  verifyStrictContinuityDatabase
} from '../runtime/orchestration/strict-continuity-store'

import {
  readRuntimeBootHistory,
  RuntimeLineageAnchor as Anchor,
  RuntimeLineageBoot as Boot,
  type OrcadRuntimeBoot
} from './orcad-runtime-lineage-records'
export type { OrcadRuntimeBoot } from './orcad-runtime-lineage-records'

function refuse(reason: string): never {
  throw new Error(`orcad_runtime_lineage_refused: ${reason}`)
}

// Local object identity detects ordinary copy/replace; it cannot prove absence of full-host rollback.
export function openOrcadRuntimeLineage(
  dataRoot: string,
  lock: OrcadInstanceLock,
  options: { existingOnly?: boolean; readonly?: boolean } = {}
) {
  assertOrcadInstanceLock(lock, dataRoot)
  const host = runtimeLineageHostIdentity()
  if (!host) {
    refuse('this platform cannot establish the planned-restart identity')
  }
  const { machine, boot, pidNamespace, processIdentity } = host
  const root = realpathSync(dataRoot)
  const rootIdentity = identity(root, true)
  const path = join(root, 'strict-runtime-lineage.db')
  let existingJournal = true
  try {
    identity(path, false)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
    if (options.existingOnly || options.readonly) {
      refuse('pre-restart journal is missing; retrospective adoption is unsupported')
    }
    existingJournal = false
  }
  const db = new Database(path, {
    fileMustExist: options.existingOnly || options.readonly,
    readonly: options.readonly
  })
  try {
    if (!options.readonly) {
      hardenSqliteDatabaseFiles(path)
    }
    const journalIdentity = identity(path, false)
    if (!options.readonly) {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = FULL')
    }
    initializeRuntimeLineageSchema(db, existingJournal)
    if (!options.readonly) {
      hardenSqliteDatabaseFiles(path)
    }
    const binding = {
      schemaVersion: 1 as const,
      platform: process.platform,
      machine,
      root,
      rootDevice: rootIdentity.device,
      rootInode: rootIdentity.inode,
      journalDevice: journalIdentity.device,
      journalInode: journalIdentity.inode
    }
    const existing = db.prepare('SELECT body FROM identity WHERE singleton = 1').get()
    if (!existing) {
      if (existingJournal) {
        refuse('missing identity in existing journal')
      }
      db.prepare('INSERT INTO identity (singleton, body) VALUES (1, ?)').run(
        JSON.stringify({ ...binding, serverId: randomUUID() })
      )
    }
    const anchor = Anchor.parse(
      JSON.parse(
        z
          .object({ body: z.string() })
          .parse(db.prepare('SELECT body FROM identity WHERE singleton = 1').get()).body
      )
    )
    if (hashCanonical(anchor) !== hashCanonical({ ...binding, serverId: anchor.serverId })) {
      refuse('Server root, machine or journal object changed')
    }
    let closed = false
    function assertCurrent() {
      if (closed) {
        refuse('journal closed')
      }
      assertOrcadInstanceLock(lock, root)
      if (
        hashCanonical(identity(root, true)) !== hashCanonical(rootIdentity) ||
        hashCanonical(identity(path, false)) !== hashCanonical(journalIdentity)
      ) {
        refuse('filesystem identity changed')
      }
      initializeRuntimeLineageSchema(db, true)
      const rows = db.prepare('SELECT body FROM main.identity LIMIT 2').all()
      if (
        rows.length !== 1 ||
        typeof rows[0]?.body !== 'string' ||
        hashCanonical(Anchor.parse(JSON.parse(rows[0].body))) !== hashCanonical(anchor)
      ) {
        refuse('Server anchor changed')
      }
    }
    function history(): OrcadRuntimeBoot[] {
      return readRuntimeBootHistory(db, anchor.serverId)
    }
    function head() {
      return history().at(-1) ?? null
    }
    function current() {
      assertCurrent()
      const boot = head()
      if (!boot || boot.lockNonce !== lock.record.nonce) {
        refuse('current Server boot required')
      }
      return boot
    }
    function transaction<T>(operation: () => T): T {
      assertCurrent()
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        assertCurrent()
        db.exec('COMMIT')
        return result
      } catch (error) {
        if (db.isTransaction) {
          db.exec('ROLLBACK')
        }
        throw error
      }
    }
    function appendBoot(runtimeId: string, nowMs: number) {
      const previous = head()
      if (previous && previous.lockNonce === lock.record.nonce) {
        refuse('this Server instance already recorded its boot')
      }
      if (previous && nowMs < previous.startedAtMs) {
        refuse('clock moved backwards')
      }
      const current = Boot.parse({
        schemaVersion: 1,
        serverId: anchor.serverId,
        runtimeId,
        epoch: (previous?.epoch ?? 0) + 1,
        previousCanonicalSha256: previous ? hashCanonical(previous) : null,
        startedAtMs: nowMs,
        boot,
        pidNamespace,
        processIdentity,
        lockNonce: lock.record.nonce
      })
      db.prepare(
        'INSERT INTO boots (epoch, runtime_id, canonical_sha256, body) VALUES (?, ?, ?, ?)'
      ).run(current.epoch, runtimeId, hashCanonical(current), JSON.stringify(current))
      return current
    }
    const lineage = {
      assertNormalStartup() {
        assertCurrent()
        history()
        // No release protocol exists: even an expired seal fences ordinary startup.
        if (db.prepare('SELECT 1 FROM main.database_seals LIMIT 1').get()) {
          refuse('journal has an unresolved database seal; normal startup is disabled')
        }
      },
      recordBoot(runtimeId: string, nowMs = Date.now()) {
        return transaction(() => appendBoot(runtimeId, nowMs))
      },
      inspectSuccessor(source: OrcadRuntimeBoot, target: OrcadRuntimeBoot) {
        assertCurrent()
        const current = head()
        if (
          !current ||
          current.lockNonce !== lock.record.nonce ||
          hashCanonical(current) !== hashCanonical(target) ||
          source.serverId !== anchor.serverId ||
          target.serverId !== source.serverId ||
          target.epoch !== source.epoch + 1 ||
          target.runtimeId === source.runtimeId ||
          target.previousCanonicalSha256 !== hashCanonical(source) ||
          target.boot !== source.boot ||
          target.pidNamespace !== source.pidNamespace ||
          target.lockNonce === source.lockNonce ||
          target.boot !== boot ||
          target.pidNamespace !== pidNamespace ||
          target.processIdentity !== processIdentity
        ) {
          refuse('not the immediate same-boot successor')
        }
        return {
          proofScope: 'local-server-boot-chain-only' as const,
          serverId: anchor.serverId,
          source,
          target,
          executionAuthorized: false as const,
          serverContinuityVerified: false as const
        }
      },
      close() {
        if (!closed) {
          db.close()
          closed = true
        }
      }
    }
    const inventory = runtimeLineageInventory({ journal: db, current })
    const seals = runtimeLineageSeals({
      journal: db,
      root,
      current,
      inspectSourceInventory: inventory.inspectSourceInventory,
      assertSuccessor: lineage.inspectSuccessor
    })
    const recovery = runtimeLineageRecovery({
      journal: db,
      history,
      current,
      inspectDatabaseSeal: seals.inspectDatabaseSeal
    })
    return {
      ...lineage,
      plannedRestart: plannedRestartJournal({
        journal: db,
        current,
        transaction,
        appendBoot,
        seals,
        assertSuccessor: lineage.inspectSuccessor
      }),
      recordSourceInventory: inventory.recordSourceInventory,
      recordDatabaseSeal: seals.recordDatabaseSeal,
      inspectDatabaseSuccessor: seals.inspectDatabaseSuccessor,
      recordRecoveryInspection(
        inspection: StrictContinuityInspection,
        expected: Parameters<typeof verifyStrictContinuityDatabase>[1],
        source: OrcadRuntimeBoot,
        runtimeId: string,
        nowMs: number,
        assertAdmission: () => void
      ) {
        return transaction(() => {
          assertAdmission()
          const proof = recovery.record(
            inspection,
            expected,
            source,
            () => appendBoot(runtimeId, nowMs),
            nowMs
          )
          assertAdmission()
          return proof
        })
      },
      inspectRecovery(...args: Parameters<typeof recovery.inspect>) {
        assertCurrent()
        const proof = recovery.inspect(...args)
        assertCurrent()
        return proof
      }
    }
  } catch (error) {
    db.close()
    throw error
  }
}
