import { vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { acquireOrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'
import type * as admission from './orcad-planned-successor'

/** Entry wiring fixture; real journal/daemon retry has separate connected coverage. */
export function plannedStartupFixture(
  root: string,
  module: typeof admission,
  activate: admission.PlannedSuccessor['activate']
) {
  const lock = acquireOrcadInstanceLock(root)
  const journal = openOrcadRuntimeLineage(root, lock)
  journal.recordBoot('source-runtime')
  journal.close()
  lock.release()
  const attempts: admission.PlannedSuccessor[] = []
  const admit = vi.spyOn(module, 'admitPlannedSuccessor').mockImplementation(async () => {
    const db = new OrchestrationDb(':memory:')
    const successor = {
      runtimeId: randomUUID(),
      db,
      maintenance: vi.fn(async () => {
        throw new Error('unused fixture maintenance')
      }),
      activate: vi.fn(activate),
      commit: vi.fn(async () => {}),
      close: vi.fn(async () => {
        db.close()
      })
    } satisfies admission.PlannedSuccessor
    attempts.push(successor)
    return successor
  })
  return {
    attempts,
    admit,
    options: {
      json: true,
      plannedRestart: {
        reviewCanonicalSha256: 'a'.repeat(64),
        proposalCanonicalSha256: 'b'.repeat(64)
      }
    }
  }
}
