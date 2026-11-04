import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { LineageSha256, type OrcadRuntimeBoot } from './orcad-runtime-lineage-records'
import {
  ContinuityInventoryScope,
  continuityFileInventory
} from './orcad-continuity-file-inventory'

const SourceInventory = z
  .object({
    schemaVersion: z.literal(1),
    sourceBootCanonicalSha256: LineageSha256,
    recordedAtMs: z.number().int().nonnegative().safe(),
    scope: ContinuityInventoryScope,
    inventoryCanonicalSha256: LineageSha256,
    executionAuthorized: z.literal(false)
  })
  .strict()

function refuse(reason: string): never {
  throw new Error(`orcad_continuity_inventory_refused: ${reason}`)
}

/** Immutable source registration; successor inspection never supplies replacement paths. */
export function runtimeLineageInventory(options: {
  journal: Database.Database
  current: () => OrcadRuntimeBoot
}) {
  const { journal, current } = options
  return {
    recordSourceInventory(scope: ContinuityInventoryScope, nowMs = Date.now()) {
      const source = current()
      if (!Number.isSafeInteger(nowMs) || nowMs < source.startedAtMs) {
        refuse('invalid source observation time')
      }
      const snapshot = continuityFileInventory(scope)
      const record = SourceInventory.parse({
        schemaVersion: 1,
        sourceBootCanonicalSha256: hashCanonical(source),
        recordedAtMs: nowMs,
        scope: snapshot.inventory.scope,
        inventoryCanonicalSha256: snapshot.inventoryCanonicalSha256,
        executionAuthorized: false
      })
      journal.exec('BEGIN IMMEDIATE')
      try {
        if (
          hashCanonical(current()) !== hashCanonical(source) ||
          continuityFileInventory(record.scope).inventoryCanonicalSha256 !==
            record.inventoryCanonicalSha256
        ) {
          refuse('source inventory changed during registration')
        }
        if (
          journal
            .prepare('SELECT 1 FROM source_inventories WHERE source_boot_sha256 = ?')
            .get(record.sourceBootCanonicalSha256)
        ) {
          refuse('source inventory already recorded')
        }
        journal
          .prepare('INSERT INTO source_inventories VALUES (?, ?, ?)')
          .run(record.sourceBootCanonicalSha256, JSON.stringify(record), hashCanonical(record))
        current()
        journal.exec('COMMIT')
        return { record, recordCanonicalSha256: hashCanonical(record), ...snapshot }
      } catch (error) {
        if (journal.isTransaction) {
          journal.exec('ROLLBACK')
        }
        throw error
      }
    },
    inspectSourceInventory(source: OrcadRuntimeBoot, nowMs: number) {
      const row = journal
        .prepare(
          'SELECT body, canonical_sha256 FROM source_inventories WHERE source_boot_sha256 = ?'
        )
        .get(hashCanonical(source))
      if (!row) {
        refuse('no pre-restart source inventory; retrospective adoption is unsupported')
      }
      const stored = z.object({ body: z.string(), canonical_sha256: LineageSha256 }).parse(row)
      const record = SourceInventory.parse(JSON.parse(stored.body))
      if (
        hashCanonical(record) !== stored.canonical_sha256 ||
        record.sourceBootCanonicalSha256 !== hashCanonical(source) ||
        record.recordedAtMs < source.startedAtMs ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < record.recordedAtMs ||
        nowMs >= record.recordedAtMs + 30 * 60_000
      ) {
        refuse('source inventory pin or time changed')
      }
      const snapshot = continuityFileInventory(record.scope)
      if (snapshot.inventoryCanonicalSha256 !== record.inventoryCanonicalSha256) {
        refuse('source files changed after registration')
      }
      return { record, recordCanonicalSha256: stored.canonical_sha256, ...snapshot }
    }
  }
}
