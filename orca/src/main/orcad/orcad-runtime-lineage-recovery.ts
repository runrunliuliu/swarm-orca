import { z } from 'zod'
import type Database from '../sqlite/sync-database'
import { hashCanonical } from '../runtime/rpc/orchestration-mutation-receipt'
import type { OrcadRuntimeBoot } from './orcad-runtime-lineage'
import type { runtimeLineageSeals } from './orcad-runtime-lineage-seals'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Admission = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('continuity-inspection-only'),
    sourceBootCanonicalSha256: Sha256,
    targetBootCanonicalSha256: Sha256,
    seal: z
      .object({
        runId: z.string().min(1),
        databaseId: z.string().uuid(),
        sealCanonicalSha256: Sha256
      })
      .strict(),
    admissionGeneration: z.number().int().positive().safe(),
    previousCanonicalSha256: Sha256.nullable()
  })
  .strict()
type Inspection = ReturnType<typeof runtimeLineageSeals>['inspectDatabaseSeal']

function refuse(): never {
  throw new Error('orcad_runtime_lineage_refused: recovery inspection ancestry changed')
}

/** Every intervening boot must have been admitted atomically as inspection-only. */
export function runtimeLineageRecovery(options: {
  journal: Database.Database
  history: () => OrcadRuntimeBoot[]
  current: () => OrcadRuntimeBoot
  inspectDatabaseSeal: Inspection
}) {
  const { journal, history, current, inspectDatabaseSeal } = options
  function chain(source: OrcadRuntimeBoot, seal: Parameters<Inspection>[1]) {
    const boots = history()
    const head = boots.at(-1)
    if (
      !head ||
      !Number.isSafeInteger(source.epoch) ||
      source.epoch < 1 ||
      !boots[source.epoch - 1] ||
      hashCanonical(boots[source.epoch - 1]) !== hashCanonical(source) ||
      head.epoch < source.epoch ||
      source.boot !== head.boot ||
      source.pidNamespace !== head.pidNamespace
    ) {
      refuse()
    }
    let previous: z.infer<typeof Admission> | null = null
    for (const boot of boots.slice(source.epoch)) {
      const row = journal
        .prepare('SELECT body, canonical_sha256 FROM recovery_inspections WHERE boot_epoch = ?')
        .get(boot.epoch)
      const stored = z.object({ body: z.string(), canonical_sha256: Sha256 }).parse(row)
      const admission = Admission.parse(JSON.parse(stored.body))
      if (
        hashCanonical(admission) !== stored.canonical_sha256 ||
        admission.sourceBootCanonicalSha256 !== hashCanonical(source) ||
        admission.targetBootCanonicalSha256 !== hashCanonical(boot) ||
        hashCanonical(admission.seal) !== hashCanonical(seal) ||
        admission.admissionGeneration !== (previous?.admissionGeneration ?? 0) + 1 ||
        admission.previousCanonicalSha256 !== (previous ? hashCanonical(previous) : null) ||
        boot.boot !== source.boot ||
        boot.pidNamespace !== source.pidNamespace
      ) {
        refuse()
      }
      previous = admission
    }
    return { head, previous }
  }
  return {
    record(
      db: Parameters<Inspection>[0],
      seal: Parameters<Inspection>[1],
      source: OrcadRuntimeBoot,
      append: () => OrcadRuntimeBoot,
      nowMs: number
    ) {
      const { previous } = chain(source, seal)
      const target = append()
      if (
        target.boot !== source.boot ||
        target.pidNamespace !== source.pidNamespace ||
        hashCanonical(current()) !== hashCanonical(target)
      ) {
        refuse()
      }
      const proof = inspectDatabaseSeal(db, seal, source, target, nowMs)
      const admission = Admission.parse({
        schemaVersion: 1,
        kind: 'continuity-inspection-only',
        sourceBootCanonicalSha256: hashCanonical(source),
        targetBootCanonicalSha256: hashCanonical(target),
        seal,
        admissionGeneration: (previous?.admissionGeneration ?? 0) + 1,
        previousCanonicalSha256: previous ? hashCanonical(previous) : null
      })
      journal
        .prepare('INSERT INTO recovery_inspections VALUES (?, ?, ?)')
        .run(target.epoch, JSON.stringify(admission), hashCanonical(admission))
      return { ...proof, admission, admissionCanonicalSha256: hashCanonical(admission) }
    },
    inspect(
      db: Parameters<Inspection>[0],
      seal: Parameters<Inspection>[1],
      source: OrcadRuntimeBoot,
      target: OrcadRuntimeBoot,
      nowMs: number
    ) {
      const { head, previous: admission } = chain(source, seal)
      if (
        !admission ||
        hashCanonical(head) !== hashCanonical(target) ||
        hashCanonical(current()) !== hashCanonical(target)
      ) {
        refuse()
      }
      const proof = inspectDatabaseSeal(db, seal, source, target, nowMs)
      return { ...proof, admission, admissionCanonicalSha256: hashCanonical(admission) }
    }
  }
}
