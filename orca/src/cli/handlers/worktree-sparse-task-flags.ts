// CLI entry for the task sparse workspace contract.
//
// Why this file exists: until now nothing outside tests sent `sparseCheckout.mode`, so a task
// workspace could not be created from any shipped entry point. These helpers turn two repeatable
// flags into the request the runtime already understands, and refuse the combinations the contract
// itself refuses — they do not re-implement any of its checks.

import { getOptionalStringFlag, getRepeatedStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { WORKTREE_SPARSE_TASK_WORKSPACE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { SparseTaskCheckoutMode } from '../../shared/worktree/create-types'
import { SPARSE_TASK_CHECKOUT_MODE } from '../../shared/worktree/create-types'

export type SparseTaskCheckoutCliRequest = {
  mode: SparseTaskCheckoutMode
  directories: string[]
  requiredPaths?: string[]
}

/**
 * `undefined` for every create that did not ask for the task contract, so legacy creates keep their
 * payload byte for byte. The runtime does the strict parsing; this only refuses contradictions that
 * would otherwise reach it as a confusing error.
 */
export function readSparseTaskCheckoutFlags(
  flags: Map<string, string | boolean>
): SparseTaskCheckoutCliRequest | undefined {
  const directories = getRepeatedStringFlag(flags, 'sparse-task-dir')
  const requiredPaths = getRepeatedStringFlag(flags, 'sparse-task-required')
  if (directories.length === 0) {
    if (requiredPaths.length > 0) {
      throw new Error('--sparse-task-required needs at least one --sparse-task-dir; nothing was created.')
    }
    return undefined
  }
  return {
    mode: SPARSE_TASK_CHECKOUT_MODE,
    directories,
    ...(requiredPaths.length > 0 ? { requiredPaths } : {})
  }
}

/**
 * Why require the decision explicitly: M0 says the first task sparse version only runs with setup
 * skipped. Defaulting it here would silently change a repo's setup behaviour, so the caller states
 * it instead, and the refusal names the flag.
 */
export function assertSparseTaskSetupDecision(
  flags: Map<string, string | boolean>,
  request: SparseTaskCheckoutCliRequest | undefined
): void {
  if (!request) {
    return
  }
  if (getOptionalStringFlag(flags, 'setup') !== 'skip') {
    throw new Error(
      'Task sparse workspaces require --setup skip: setup hooks run commands before the workspace is verified, so nothing was created.'
    )
  }
}

/**
 * Why check before the call: an older host strips `mode` and answers with a legacy sparse success,
 * which the caller must not read as a task workspace. Nothing is created before this passes.
 */
export async function assertSparseTaskWorkspaceCapability(
  client: { call: <T>(method: string) => Promise<{ result?: T }> },
  request: SparseTaskCheckoutCliRequest | undefined
): Promise<void> {
  if (!request) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result?.capabilities?.includes(WORKTREE_SPARSE_TASK_WORKSPACE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The connected Orca runtime does not support task sparse workspaces. Update or restart Orca and try again. Nothing was created.'
    )
  }
}
