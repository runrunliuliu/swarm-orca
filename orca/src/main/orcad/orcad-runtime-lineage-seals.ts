import { join, resolve } from 'node:path'
import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import {
  verifyStrictContinuityDatabase,
  type StrictContinuityInspection
} from '../runtime/orchestration/strict-continuity-store'
import { continuityFileIdentity } from './orcad-continuity-file-identity'
import type { OrcadRuntimeBoot } from './orcad-runtime-lineage'
import type { runtimeLineageInventory } from './orcad-runtime-lineage-inventory'

type ExpectedSeal = Parameters<typeof verifyStrictContinuityDatabase>[1]
const RecordedSeal = z
  .object({
    schemaVersion: z.literal(1),
    sourceBootCanonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runId: z.string(),
    databaseId: z.string().uuid(),
    sealCanonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    databaseFile: z.object({ device: z.string(), inode: z.string() }).strict(),
    recordedAtMs: z.number().int().nonnegative(),
    sourceInventoryCanonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    executionAuthorized: z.literal(false)
  })
  .strict()

function refuse(reason: string): never {
  throw new Error(`orcad_runtime_lineage_refused: ${reason}`)
}

// Internal only: file scope authority, caller reconciliation and review remain separate gates.
export function runtimeLineageSeals(options: {
  journal: Database.Database
  root: string
  current: () => OrcadRuntimeBoot
  inspectSourceInventory: ReturnType<typeof runtimeLineageInventory>['inspectSourceInventory']
  assertSuccessor: (source: OrcadRuntimeBoot, target: OrcadRuntimeBoot) => unknown
}) {
  const { journal, root, current, assertSuccessor, inspectSourceInventory } = options
  function databaseFile(db: StrictContinuityInspection) {
    const files = z
      .array(z.object({ name: z.string(), file: z.string() }))
      .parse(db.db.pragma('database_list'))
    const main = files.find((file) => file.name === 'main')
    if (!main?.file || resolve(main.file) !== join(root, 'orchestration.db')) {
      refuse('database is not the locked Server database')
    }
    return continuityFileIdentity(main.file)
  }

  const seals = {
    recordDatabaseSeal(db: StrictContinuityInspection, expected: ExpectedSeal, nowMs = Date.now()) {
      const boot = current()
      const proof = verifyStrictContinuityDatabase(db, expected, nowMs)
      if (
        proof.seal.sourceRuntimeId !== boot.runtimeId ||
        proof.seal.sealedAtMs < boot.startedAtMs
      ) {
        refuse('seal was not created during this Server boot')
      }
      const inventory = inspectSourceInventory(boot, nowMs)
      if (inventory.record.recordedAtMs > proof.seal.sealedAtMs) {
        refuse('source inventory must precede the database seal')
      }
      const record = RecordedSeal.parse({
        schemaVersion: 1,
        sourceBootCanonicalSha256: hashCanonical(boot),
        ...expected,
        databaseFile: databaseFile(db),
        recordedAtMs: nowMs,
        sourceInventoryCanonicalSha256: inventory.recordCanonicalSha256,
        executionAuthorized: false
      })
      journal.exec('BEGIN IMMEDIATE')
      try {
        current()
        const existing = journal
          .prepare('SELECT body FROM database_seals WHERE source_boot_sha256 = ?')
          .get(record.sourceBootCanonicalSha256)
        if (existing) {
          refuse('a database seal was already recorded for this boot')
        }
        journal
          .prepare('INSERT INTO database_seals VALUES (?, ?, ?)')
          .run(record.sourceBootCanonicalSha256, JSON.stringify(record), hashCanonical(record))
        current()
        inspectSourceInventory(boot, nowMs)
        journal.exec('COMMIT')
        return { record, recordCanonicalSha256: hashCanonical(record) }
      } catch (error) {
        if (journal.isTransaction) {
          journal.exec('ROLLBACK')
        }
        throw error
      }
    },
    inspectDatabaseSeal(
      db: StrictContinuityInspection,
      expected: ExpectedSeal,
      source: OrcadRuntimeBoot,
      target: OrcadRuntimeBoot,
      nowMs = Date.now()
    ) {
      const row = journal
        .prepare('SELECT body, canonical_sha256 FROM database_seals WHERE source_boot_sha256 = ?')
        .get(hashCanonical(source))
      if (!row) {
        refuse('no pre-restart Server seal record; retrospective adoption is unsupported')
      }
      const stored = z.object({ body: z.string(), canonical_sha256: z.string() }).parse(row)
      const record = RecordedSeal.parse(JSON.parse(stored.body))
      const proof = verifyStrictContinuityDatabase(db, expected, nowMs)
      const inventory = inspectSourceInventory(source, nowMs)
      if (
        hashCanonical(record) !== stored.canonical_sha256 ||
        record.sourceInventoryCanonicalSha256 !== inventory.recordCanonicalSha256 ||
        inventory.record.recordedAtMs > proof.seal.sealedAtMs ||
        record.sourceBootCanonicalSha256 !== hashCanonical(source) ||
        record.runId !== expected.runId ||
        record.databaseId !== expected.databaseId ||
        record.sealCanonicalSha256 !== expected.sealCanonicalSha256 ||
        hashCanonical(record.databaseFile) !== hashCanonical(databaseFile(db)) ||
        proof.seal.sourceRuntimeId !== source.runtimeId ||
        proof.seal.sealedAtMs < source.startedAtMs ||
        record.recordedAtMs < proof.seal.sealedAtMs ||
        target.startedAtMs < record.recordedAtMs ||
        nowMs < target.startedAtMs
      ) {
        refuse('Server/database seal chain changed')
      }
      return {
        proofScope: 'local-server-and-database-seal-only' as const,
        record,
        recordCanonicalSha256: stored.canonical_sha256,
        source,
        target,
        databaseConsistent: true as const,
        sourceInventory: inventory,
        serverContinuityVerified: false as const,
        executionAuthorized: false as const,
        state: 'sealed_not_resumable' as const
      }
    }
  }
  return {
    ...seals,
    inspectDatabaseSuccessor(...args: Parameters<typeof seals.inspectDatabaseSeal>) {
      assertSuccessor(args[2], args[3])
      const proof = seals.inspectDatabaseSeal(...args)
      assertSuccessor(args[2], args[3])
      return proof
    }
  }
}
