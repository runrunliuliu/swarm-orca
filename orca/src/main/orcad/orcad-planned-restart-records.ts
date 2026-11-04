import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import { strictTerminalAuthoritySchema } from '../runtime/orchestration/strict-coordinator-policy'
import { LineageSha256, RuntimeLineageBoot } from './orcad-runtime-lineage-records'
import { DaemonRestartPinSchema } from '../daemon/daemon-planned-restart-client'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isEquivalentPaneKey } from '../runtime/orchestration/db/pane-key-match'

export function samePlannedActor(
  a: z.infer<typeof strictTerminalAuthoritySchema>,
  b: z.infer<typeof strictTerminalAuthoritySchema>
) {
  return (
    a.terminalHandle === b.terminalHandle ||
    (hashCanonical(a.hostScope) === hashCanonical(b.hostScope) &&
      (isEquivalentPaneKey(a.paneKey, b.paneKey) ||
        a.processIncarnation === b.processIncarnation ||
        a.launchTokenHash === b.launchTokenHash))
  )
}

export function assertPlannedTerminal(
  runtime: OrcaRuntimeService,
  expected: z.infer<typeof strictTerminalAuthoritySchema>
) {
  const actual = runtime.getOrchestrationDispatchAuthority(expected.terminalHandle)
  if (
    !actual ||
    hashCanonical({
      terminalHandle: actual.terminalHandle,
      paneKey: actual.paneKey,
      processIncarnation: actual.processIncarnation,
      hostScope: actual.hostScope,
      launchTokenHash: actual.launchTokenHash ?? expected.launchTokenHash
    }) !== hashCanonical(expected)
  ) {
    throw new Error('planned_restart_terminal_identity_changed')
  }
}

export const Preparation = z.strictObject({
  schemaVersion: z.literal(1),
  source: RuntimeLineageBoot,
  runId: z.string().min(1),
  proposalCanonicalSha256: LineageSha256,
  preparer: strictTerminalAuthoritySchema,
  sender: strictTerminalAuthoritySchema,
  proposal: z.record(z.string(), z.unknown()).optional(),
  daemon: DaemonRestartPinSchema.optional()
})
export const Review = z.strictObject({
  schemaVersion: z.literal(1),
  source: RuntimeLineageBoot,
  seal: z.strictObject({
    runId: z.string(),
    databaseId: z.string().uuid(),
    sealCanonicalSha256: LineageSha256
  }),
  proposalCanonicalSha256: LineageSha256,
  preparationCanonicalSha256: LineageSha256,
  reviewerAuthoritySha256: LineageSha256,
  reviewedAtMs: z.number().int().nonnegative(),
  reason: z.string().min(1)
})
export const Consumption = z.strictObject({
  schemaVersion: z.literal(1),
  reviewCanonicalSha256: LineageSha256,
  target: RuntimeLineageBoot
})

export function refuseRestart(reason: string): never {
  throw new Error(`orcad_planned_restart_refused: ${reason}`)
}

export function plannedRestartRecords(journal: Database.Database) {
  type Stage = 'prepare' | 'review' | 'attempt' | 'consume'
  return {
    continuationCycle(runtimeId: string) {
      const row = journal
        .prepare(
          "SELECT cycle FROM planned_restarts WHERE stage = 'consume' AND json_extract(body, '$.target.runtimeId') = ? ORDER BY rowid DESC LIMIT 1"
        )
        .get(runtimeId)
      return row ? z.object({ cycle: LineageSha256 }).parse(row).cycle : undefined
    },
    latestCycle() {
      if (!journal.prepare("SELECT 1 FROM sqlite_master WHERE name = 'planned_restarts'").get()) {
        return undefined
      }
      const row = journal
        .prepare(
          "SELECT cycle FROM planned_restarts WHERE stage = 'prepare' ORDER BY rowid DESC LIMIT 1"
        )
        .get()
      return row ? z.object({ cycle: LineageSha256 }).parse(row).cycle : undefined
    },
    read(cycle: string, stage: Stage) {
      const row = journal
        .prepare(
          'SELECT body, canonical_sha256 FROM planned_restarts WHERE cycle = ? AND stage = ? ORDER BY attempt DESC LIMIT 1'
        )
        .get(cycle, stage)
      if (!row) {
        return undefined
      }
      const stored = z.object({ body: z.string(), canonical_sha256: LineageSha256 }).parse(row)
      const body: unknown = JSON.parse(stored.body)
      if (hashCanonical(body) !== stored.canonical_sha256) {
        refuseRestart('journal record pin changed')
      }
      return body
    },
    insert(cycle: string, stage: Stage, body: unknown, attempt = 0) {
      journal
        .prepare('INSERT INTO planned_restarts VALUES (?, ?, ?, ?, ?)')
        .run(cycle, stage, attempt, JSON.stringify(body), hashCanonical(body))
    }
  }
}
