import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'

export const LineageSha256 = z.string().regex(/^[a-f0-9]{64}$/)
export const RuntimeLineageAnchor = z
  .object({
    schemaVersion: z.literal(1),
    serverId: z.string().uuid(),
    platform: z.string(),
    machine: z.string().min(1),
    root: z.string(),
    rootDevice: z.string(),
    rootInode: z.string(),
    journalDevice: z.string(),
    journalInode: z.string()
  })
  .strict()
export const RuntimeLineageBoot = z
  .object({
    schemaVersion: z.literal(1),
    serverId: z.string().uuid(),
    runtimeId: z.string().min(1),
    epoch: z.number().int().positive().safe(),
    previousCanonicalSha256: LineageSha256.nullable(),
    startedAtMs: z.number().int().nonnegative().safe(),
    boot: z.string().min(1),
    pidNamespace: z.string().min(1),
    processIdentity: z.string().min(1),
    lockNonce: z.string().min(1)
  })
  .strict()
export type OrcadRuntimeBoot = z.infer<typeof RuntimeLineageBoot>

export function readRuntimeBootHistory(
  db: Database.Database,
  serverId: string
): OrcadRuntimeBoot[] {
  const rows = db
    .prepare(
      'SELECT epoch, runtime_id, body, canonical_sha256 FROM boots ORDER BY epoch LIMIT 10001'
    )
    .all()
  if (rows.length > 10000) {
    throw new Error('orcad_runtime_lineage_refused: boot history exceeds inspection limit')
  }
  let previous: OrcadRuntimeBoot | null = null
  const nonces = new Set<string>()
  return rows.map((row) => {
    const parsed = z
      .object({
        epoch: z.number(),
        runtime_id: z.string(),
        body: z.string(),
        canonical_sha256: LineageSha256
      })
      .parse(row)
    const value = RuntimeLineageBoot.parse(JSON.parse(parsed.body))
    if (
      value.serverId !== serverId ||
      hashCanonical(value) !== parsed.canonical_sha256 ||
      value.epoch !== parsed.epoch ||
      value.runtimeId !== parsed.runtime_id ||
      value.epoch !== (previous?.epoch ?? 0) + 1 ||
      value.previousCanonicalSha256 !== (previous ? hashCanonical(previous) : null) ||
      value.startedAtMs < (previous?.startedAtMs ?? 0) ||
      nonces.has(value.lockNonce)
    ) {
      throw new Error('orcad_runtime_lineage_refused: boot pin or ancestry mismatch')
    }
    nonces.add(value.lockNonce)
    previous = value
    return value
  })
}
