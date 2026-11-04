import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { StrictContinuityAdmissionError } from '../runtime/orchestration/strict-continuity-admission'
import type { OrcadInstanceLock } from './orcad-instance-lock'
import { openOrcadRuntimeLineage } from './orcad-runtime-lineage'

/** Inspect independent evidence before opening any ordinary runtime writer. */
export function assertOrcadContinuityStartup(root: string, lock: OrcadInstanceLock): void {
  try {
    lstatSync(join(root, 'strict-runtime-lineage.db'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return
    }
    throw new StrictContinuityAdmissionError('Cannot inspect the lineage path', { cause: error })
  }
  let journal: ReturnType<typeof openOrcadRuntimeLineage> | undefined
  try {
    journal = openOrcadRuntimeLineage(root, lock, { existingOnly: true, readonly: true })
    journal.assertNormalStartup()
  } catch (error) {
    throw new StrictContinuityAdmissionError('Read-only Server lineage admission failed', {
      cause: error
    })
  } finally {
    journal?.close()
  }
}
