import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OrchestrationDb } from './db'
import { hashCanonical } from '../rpc/orchestration-mutation-receipt'
import { strictCoordinatorPolicy, strictRunRetirement } from './strict-coordinator-policy'
import { OrchestrationError } from './orchestration-error'
import { strictContinuitySnapshot } from './strict-continuity-snapshot'
import { assertStrictContinuitySchema } from './db/schema/strict-continuity-schema'
import { assertStrictContinuityEffectsIdle } from './strict-continuity-effects'
import { hasStrictContinuityResume } from './strict-continuity-resume'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
export type StrictContinuityInspection = {
  db: OrchestrationDb['db']
  getRun: OmitThisParameter<OrchestrationDb['getRun']>
}
const Seal = z
  .object({
    schemaVersion: z.literal(1),
    proofScope: z.literal('orchestration-database-snapshot-only'),
    databaseId: z.string().uuid(),
    runId: z.string().min(1),
    sourceRuntimeId: z.string().min(1),
    recoveryEpoch: z.number().int().positive(),
    sealedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
    snapshotCanonicalSha256: Sha256,
    bindingCanonicalSha256: Sha256,
    executionAuthorized: z.literal(false)
  })
  .strict()

export function continuityRefusal(reason: string): never {
  throw new OrchestrationError('strict_continuity_required', reason)
}

function transaction<T>(db: StrictContinuityInspection, operation: () => T, readOnly = false): T {
  db.db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.db.isTransaction) {
      db.db.exec('ROLLBACK')
    }
    throw error
  }
}

function binding(db: StrictContinuityInspection, runId: string) {
  const run = db.getRun(runId)
  const policy = strictCoordinatorPolicy(db, runId)
  if (!run || !policy || strictRunRetirement(db, runId) !== undefined) {
    continuityRefusal('A live, pinned strict Run is required')
  }
  return { run, policy }
}

function assertNoUnknownMutation(db: StrictContinuityInspection) {
  if (db.db.prepare("SELECT 1 FROM main.mutation_receipts WHERE state = 'pending' LIMIT 1").get()) {
    continuityRefusal('Reconcile pending native requests before sealing')
  }
}

/** Internal database primitive; callers still need trusted Server admission and quiescence. */
export function sealStrictContinuityDatabase(
  db: StrictContinuityInspection,
  options: { runId: string; sourceRuntimeId: string; expiresAtMs: number },
  nowMs = Date.now()
) {
  assertStrictContinuitySchema(db.db)
  assertStrictContinuityEffectsIdle(db.db)
  // Seal durability cannot inherit the ordinary runtime's synchronous=NORMAL policy.
  db.db.pragma('synchronous = FULL')
  return transaction(db, () => {
    const previous = db.db
      .prepare(
        'SELECT recovery_epoch, source_runtime_id FROM main.strict_continuity_seals ORDER BY recovery_epoch DESC LIMIT 1'
      )
      .get()
    if (
      previous &&
      (!hasStrictContinuityResume(db.db) || previous.source_runtime_id === options.sourceRuntimeId)
    ) {
      continuityRefusal('A seal already exists; do not overwrite or retrospectively reseal')
    }
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      !Number.isSafeInteger(options.expiresAtMs) ||
      options.expiresAtMs <= nowMs ||
      options.expiresAtMs > nowMs + 30 * 60_000 ||
      !options.sourceRuntimeId
    ) {
      continuityRefusal('Seal requires a runtime and a future deadline within 30 minutes')
    }
    assertNoUnknownMutation(db)
    const identity = binding(db, options.runId)
    db.db
      .prepare(`INSERT OR IGNORE INTO main.strict_continuity_database
      (singleton, database_id) VALUES (1, ?)`)
      .run(randomUUID())
    const { database_id: databaseId } = z
      .object({ database_id: z.string().uuid() })
      .parse(
        db.db
          .prepare('SELECT database_id FROM main.strict_continuity_database WHERE singleton = 1')
          .get()
      )
    const seal = Seal.parse({
      schemaVersion: 1,
      proofScope: 'orchestration-database-snapshot-only',
      databaseId,
      runId: options.runId,
      sourceRuntimeId: options.sourceRuntimeId,
      recoveryEpoch: previous ? z.number().int().positive().parse(previous.recovery_epoch) + 1 : 1,
      sealedAtMs: nowMs,
      expiresAtMs: options.expiresAtMs,
      snapshotCanonicalSha256: strictContinuitySnapshot(db),
      bindingCanonicalSha256: hashCanonical(identity),
      executionAuthorized: false
    })
    db.db
      .prepare(`INSERT INTO main.strict_continuity_seals
      (recovery_epoch, run_id, source_runtime_id, expires_at_ms, snapshot_canonical_sha256, seal)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        seal.recoveryEpoch,
        seal.runId,
        seal.sourceRuntimeId,
        seal.expiresAtMs,
        seal.snapshotCanonicalSha256,
        JSON.stringify(seal)
      )
    return { seal, sealCanonicalSha256: hashCanonical(seal) }
  })
}

/** A matching database snapshot is NOT Server lineage, idle proof, review, or a resume permit. */
export function verifyStrictContinuityDatabase(
  db: StrictContinuityInspection,
  expected: { runId: string; databaseId: string; sealCanonicalSha256: string },
  nowMs = Date.now()
) {
  return transaction(
    db,
    () => {
      assertStrictContinuitySchema(db.db)
      const rows = db.db
        .prepare(`SELECT recovery_epoch, run_id, source_runtime_id, expires_at_ms,
        snapshot_canonical_sha256, seal FROM main.strict_continuity_seals ORDER BY recovery_epoch DESC LIMIT 1`)
        .all()
      if (rows.length === 0) {
        continuityRefusal('No pre-restart seal; retrospective adoption is unsupported')
      }
      if (rows.length !== 1) {
        continuityRefusal('Exactly one pre-restart seal is required')
      }
      const row = z
        .object({
          recovery_epoch: z.number(),
          run_id: z.string(),
          source_runtime_id: z.string(),
          expires_at_ms: z.number(),
          snapshot_canonical_sha256: Sha256,
          seal: z.string()
        })
        .parse(rows[0])
      const seal = Seal.parse(JSON.parse(row.seal))
      const identity = z
        .object({ database_id: z.string().uuid() })
        .parse(
          db.db
            .prepare('SELECT database_id FROM main.strict_continuity_database WHERE singleton = 1')
            .get()
        )
      if (
        seal.databaseId !== expected.databaseId ||
        identity.database_id !== expected.databaseId ||
        seal.runId !== expected.runId ||
        row.run_id !== seal.runId ||
        row.recovery_epoch !== seal.recoveryEpoch ||
        row.source_runtime_id !== seal.sourceRuntimeId ||
        row.expires_at_ms !== seal.expiresAtMs ||
        row.snapshot_canonical_sha256 !== seal.snapshotCanonicalSha256 ||
        hashCanonical(seal) !== expected.sealCanonicalSha256
      ) {
        continuityRefusal('Database or canonical seal pin mismatch')
      }
      if (!Number.isSafeInteger(nowMs) || nowMs < seal.sealedAtMs || nowMs >= seal.expiresAtMs) {
        continuityRefusal('Seal expired or system time moved backwards')
      }
      assertNoUnknownMutation(db)
      if (
        hashCanonical(binding(db, expected.runId)) !== seal.bindingCanonicalSha256 ||
        strictContinuitySnapshot(db) !== seal.snapshotCanonicalSha256
      ) {
        continuityRefusal('Database changed after sealing; reconcile instead of replaying')
      }
      return {
        seal,
        sealCanonicalSha256: expected.sealCanonicalSha256,
        databaseConsistent: true,
        serverContinuityVerified: false,
        executionAuthorized: false,
        state: 'sealed_not_resumable' as const
      }
    },
    true
  )
}

// Query every time: a different connection may have sealed since this process last checked.
export function assertNoStrictContinuitySeal(db: OrchestrationDb): void {
  if (isStrictContinuityFenced(db)) {
    continuityRefusal('Database sealed for continuity inspection; control writes remain fenced')
  }
}

export function isStrictContinuityFenced(db: OrchestrationDb): boolean {
  return hasStrictContinuitySeal(db) && !hasStrictContinuityResume(db.db)
}

export function hasStrictContinuitySeal(db: OrchestrationDb): boolean {
  return Boolean(db.db.prepare('SELECT 1 FROM main.strict_continuity_seals LIMIT 1').get())
}
