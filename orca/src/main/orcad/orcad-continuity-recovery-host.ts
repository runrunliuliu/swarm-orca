import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireProfileStateMaintenance,
  type ProfileStateMaintenance
} from '../persistence/profile-state/profile-state-access'
import { openStrictContinuityInspection } from '../runtime/orchestration/strict-continuity-inspection'
import { StrictContinuityAdmissionError } from '../runtime/orchestration/strict-continuity-admission'
import type { verifyStrictContinuityDatabase } from '../runtime/orchestration/strict-continuity-store'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { continuityFileIdentity } from './orcad-continuity-file-identity'
import { openOrcadRuntimeLineage, type OrcadRuntimeBoot } from './orcad-runtime-lineage'

type RecoveryPins = {
  source: OrcadRuntimeBoot
  seal: Parameters<typeof verifyStrictContinuityDatabase>[1]
}

/** Internal inspection host only: no RuntimeService, PTY, RPC, pairing or resume capability. */
export function startOrcadContinuityRecoveryHost(dataRoot: string, pins: RecoveryPins) {
  const root = realpathSync(dataRoot)
  continuityFileIdentity(root, true)
  const expected = structuredClone(pins)
  const instance = acquireOrcadInstanceLock(root)
  let maintenance: ProfileStateMaintenance | undefined
  let journal: ReturnType<typeof openOrcadRuntimeLineage> | undefined
  let inspection: ReturnType<typeof openStrictContinuityInspection> | undefined
  let closed = false
  function close() {
    if (closed) {
      return
    }
    // A failed teardown retains both locks until the process exits.
    inspection?.close()
    journal?.close()
    maintenance?.release()
    instance.release()
    closed = true
  }
  try {
    maintenance = acquireProfileStateMaintenance(root)
    continuityFileIdentity(join(root, 'orchestration.db'))
    journal = openOrcadRuntimeLineage(root, instance, { existingOnly: true })
    inspection = openStrictContinuityInspection(join(root, 'orchestration.db'))
    const held = { journal, inspection, maintenance }
    const proof = journal.recordRecoveryInspection(
      inspection,
      expected.seal,
      expected.source,
      randomUUID(),
      Date.now(),
      () => held.maintenance.assertActive()
    )
    const target = structuredClone(proof.target)
    return Object.freeze({
      mode: 'continuity-inspection-only' as const,
      inspect() {
        if (closed) {
          throw new StrictContinuityAdmissionError('Recovery inspection host is closed')
        }
        held.maintenance.assertActive()
        const current = held.journal.inspectRecovery(
          held.inspection,
          expected.seal,
          expected.source,
          target,
          Date.now()
        )
        held.maintenance.assertActive()
        return structuredClone(current)
      },
      close
    })
  } catch (error) {
    try {
      close()
    } catch (cleanupError) {
      console.error('[orcad] continuity inspection cleanup failed:', cleanupError)
    }
    throw new StrictContinuityAdmissionError('Recovery inspection admission failed', {
      cause: error
    })
  }
}
