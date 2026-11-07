// M3 (minimum): a task workspace may only be launched when it still is the workspace the create
// proved. The binding says which baseline and which declarations the task started with; this module
// checks them against the workspace as it is now, and refuses to launch when it cannot.
//
// Why at launch and not only at create: HEAD legitimately moves while an agent works, the cone can
// be widened from a terminal, and a declared path can disappear. None of those are visible in the
// create-time receipt, so the create-time HEAD-equals-pin rule cannot be re-used here.
//
// Nothing here writes: no repair, no cone widening, no full-checkout fallback.

import type { SparseTaskWorkspaceBinding } from '../../shared/worktree/sparse-task-binding'
import { parseSparseTaskWorkspaceBinding } from '../../shared/worktree/sparse-task-binding'
import { gitExecFileAsync } from '../git/runner'
import {
  gitExecOptions,
  type GitWorktreeExecOptions
} from '../git/worktree-operation-options'
import { verifySparseTaskRequiredPaths } from '../git/sparse-task-required-paths'
import { readSparseTaskEffectiveCone, sparseConeCovers } from '../git/sparse-task-sparse-state'
import { readCreatedWorktreeHead } from './created-worktree-reconciliation'

export const SPARSE_TASK_START_GATE_CODE = 'sparse_task_start_gate_failed' as const

/**
 * Why three reasons and not one: a caller (and a human) must be able to tell an edited record from
 * a workspace that drifted from one that simply could not be read. They lead to different actions.
 */
export type SparseTaskStartGateReason = 'binding_invalid' | 'not_ready' | 'unverified'

export class SparseTaskStartGateError extends Error {
  readonly code = SPARSE_TASK_START_GATE_CODE
  readonly reason: SparseTaskStartGateReason

  constructor(reason: SparseTaskStartGateReason, detail: string) {
    super(`[${SPARSE_TASK_START_GATE_CODE}:${reason}] ${detail}`)
    this.name = 'SparseTaskStartGateError'
    this.reason = reason
  }
}

/** The persisted shape the gate reads; kept structural so tests and callers can pass a store stub. */
export type TaskBindingMetaReader = {
  getWorktreeMeta?: (worktreeId: string) => { sparseTaskBinding?: unknown } | undefined
}

export type LaunchableTaskWorkspace = {
  id: string
  path: string
  /** Remote workspaces are not gated in v1: the probe would run on this host, not the worktree's. */
  connectionId?: string | null
}

const MERGE_BASE_TIMEOUT_MS = 10_000

/**
 * Is `pinnedSha` still part of the workspace's history?
 *
 * Why ancestry and not equality: the agent is expected to commit. What must not happen is a workspace
 * whose HEAD no longer contains the baseline the task was authorized against (a rebase onto
 * something else, a reset, a different branch).
 */
async function pinnedShaIsAncestor(
  worktreePath: string,
  pinnedSha: string,
  options: GitWorktreeExecOptions
): Promise<boolean> {
  const bounded: GitWorktreeExecOptions = { ...options, timeout: MERGE_BASE_TIMEOUT_MS }
  try {
    await gitExecFileAsync(
      ['merge-base', '--is-ancestor', pinnedSha, 'HEAD'],
      gitExecOptions(worktreePath, bounded)
    )
    return true
  } catch (error) {
    // exit 1 is Git's "no, not an ancestor"; anything else is an unreadable answer, not a refusal.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 1) {
      return false
    }
    throw error
  }
}

/**
 * Verify a bound workspace against its own declaration. Throws `SparseTaskStartGateError`; returns
 * nothing on success, because there is no partial "ready" state worth reporting to a launcher.
 */
export async function assertTaskWorkspaceReadyToLaunch(args: {
  binding: SparseTaskWorkspaceBinding
  worktreePath: string
  options?: GitWorktreeExecOptions
}): Promise<void> {
  const { binding, worktreePath } = args
  const options = args.options ?? {}
  let head: string
  try {
    head = await readCreatedWorktreeHead(worktreePath, options)
  } catch (error) {
    throw new SparseTaskStartGateError(
      'unverified',
      `The workspace HEAD at ${worktreePath} could not be read: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  let ancestor: boolean
  try {
    ancestor = await pinnedShaIsAncestor(worktreePath, binding.pinnedSha, options)
  } catch (error) {
    throw new SparseTaskStartGateError(
      'unverified',
      `Whether ${worktreePath} still contains the pinned ${binding.pinnedSha} could not be determined: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!ancestor) {
    throw new SparseTaskStartGateError(
      'not_ready',
      `The workspace at ${worktreePath} is at ${head}, which no longer contains the pinned ${binding.pinnedSha}.`
    )
  }
  if (binding.requestedSparseCone.length > 0) {
    let effectiveCone: string[]
    try {
      effectiveCone = await readSparseTaskEffectiveCone(worktreePath, options)
    } catch (error) {
      throw new SparseTaskStartGateError(
        'unverified',
        `The sparse cone of ${worktreePath} could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const uncovered = binding.requestedSparseCone.filter(
      (directory) => !sparseConeCovers(effectiveCone, directory)
    )
    if (uncovered.length > 0) {
      throw new SparseTaskStartGateError(
        'not_ready',
        `The workspace at ${worktreePath} no longer covers the declared cone: ${uncovered.join(', ')}.`
      )
    }
  }
  if (binding.requiredPaths.length > 0) {
    let check: Awaited<ReturnType<typeof verifySparseTaskRequiredPaths>>
    try {
      check = await verifySparseTaskRequiredPaths({
        worktreePath,
        requiredPaths: binding.requiredPaths
      })
    } catch (error) {
      throw new SparseTaskStartGateError(
        'unverified',
        `The declared paths of ${worktreePath} could not be checked: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (check.missingPaths.length > 0) {
      throw new SparseTaskStartGateError(
        'not_ready',
        `The workspace at ${worktreePath} is missing declared paths: ${check.missingPaths.join(', ')}.`
      )
    }
    if (check.unverifiablePaths.length > 0) {
      throw new SparseTaskStartGateError(
        'unverified',
        `The workspace at ${worktreePath} has declared paths that could not be checked: ${check.unverifiablePaths.join(', ')}.`
      )
    }
  }
}

/**
 * The launch gate every terminal/session path calls after resolving its workspace.
 *
 * Why the binding decides whether there is anything to gate: a workspace without one was not created
 * from a task receipt (legacy full, legacy sparse, external), so gating it would break existing
 * workspaces and sessions. A workspace that *claims* a binding it cannot parse is the opposite —
 * that is a record we must not honour silently.
 */
export async function assertTaskWorkspaceLaunchableFor(args: {
  store: TaskBindingMetaReader | undefined
  workspace: LaunchableTaskWorkspace
  options?: GitWorktreeExecOptions
}): Promise<void> {
  const raw = args.store?.getWorktreeMeta?.(args.workspace.id)?.sparseTaskBinding
  if (raw === undefined) {
    return
  }
  const binding = parseSparseTaskWorkspaceBinding(raw)
  if (!binding) {
    throw new SparseTaskStartGateError(
      'binding_invalid',
      `The stored task binding of ${args.workspace.path} is not readable as schema v1, so this workspace cannot be proven to be a task workspace. Check it before launching; nothing was changed.`
    )
  }
  if (args.workspace.connectionId) {
    // Why skip instead of guessing: the probe must run on the host that owns the worktree.
    return
  }
  await assertTaskWorkspaceReadyToLaunch({
    binding,
    worktreePath: args.workspace.path,
    ...(args.options ? { options: args.options } : {})
  })
}
