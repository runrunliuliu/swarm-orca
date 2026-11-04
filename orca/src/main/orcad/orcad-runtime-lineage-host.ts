import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  profileStateAccessBootIdentity,
  profileStateAccessMachineIdentity,
  profileStateAccessProcessIdentity
} from '../persistence/profile-state/profile-state-access-identity'
import { profileStateAccessPidNamespace } from '../persistence/profile-state/profile-state-access-owner'

export function runtimeLineageHostIdentity() {
  if (process.platform !== 'linux') {
    return null
  }
  const machine = profileStateAccessMachineIdentity()
  const boot = profileStateAccessBootIdentity()
  const pidNamespace = profileStateAccessPidNamespace()
  const processIdentity = profileStateAccessProcessIdentity(process.pid)
  return machine && boot && pidNamespace && processIdentity
    ? { machine, boot, pidNamespace, processIdentity }
    : null
}

/** Missing host primitives disable first-time enrollment, never an existing continuity chain. */
export function shouldRecordRuntimeLineage(dataRoot: string): boolean {
  try {
    lstatSync(join(dataRoot, 'strict-runtime-lineage.db'))
    return true
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  if (runtimeLineageHostIdentity()) {
    return true
  }
  if (process.platform === 'linux') {
    console.warn('[orcad] planned-restart continuity unavailable: host identity is incomplete')
  }
  return false
}
