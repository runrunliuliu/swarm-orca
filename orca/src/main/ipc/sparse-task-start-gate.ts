// M3 (minimum): a task workspace may only be launched when it still is the workspace the create
// proved. The binding says which baseline and which declarations the task started with; this module
// checks them against the workspace as it is now, and refuses to launch when it cannot.
//
// Why at launch and not only at create: HEAD legitimately moves while an agent works, the cone can
// be widened from a terminal, and a declared path can disappear. None of those are visible in the
// create-time receipt, so the create-time HEAD-equals-pin rule cannot be re-used here.
//
// Nothing here writes: no repair, no cone widening, no full-checkout fallback.

import { stat } from 'node:fs/promises'
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

/**
 * The launch decision, written down. Same probes as the gate, no throwing: a client asking "can this
 * workspace be used?" should get an answer, not an exception with a reason code buried in its text.
 *
 * `unbound` is not a state of a task workspace — it is the answer for every workspace the task
 * contract never applied to (legacy full, legacy sparse, external create).
 */
export type TaskWorkspaceReadinessState =
  | 'unbound'
  | 'ready'
  | 'drifted'
  | 'unverified'
  | 'binding_invalid'
  /** Bound, but this host cannot probe it (remote in v1). Not a failure and not a pass. */
  | 'not_probed'

export type TaskWorkspaceReadiness = {
  state: TaskWorkspaceReadinessState
  /** Why the state is what it is; empty for `ready` and `unbound`. */
  reasons: string[]
  pinnedSha?: string
  head?: string
  checkedAt: number
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
export async function inspectTaskWorkspaceReadiness(args: {
  binding: SparseTaskWorkspaceBinding
  worktreePath: string
  options?: GitWorktreeExecOptions
}): Promise<TaskWorkspaceReadiness> {
  const { binding, worktreePath } = args
  const options = args.options ?? {}
  const report: TaskWorkspaceReadiness = {
    state: 'ready',
    reasons: [],
    pinnedSha: binding.pinnedSha,
    checkedAt: Date.now()
  }
  const drift = (reason: string): TaskWorkspaceReadiness => {
    report.state = 'drifted'
    report.reasons.push(reason)
    return report
  }
  let unknown = false
  const unproven = (reason: string): void => {
    unknown = true
    report.reasons.push(reason)
  }
  try {
    report.head = await readCreatedWorktreeHead(worktreePath, options)
  } catch (error) {
    unproven(`HEAD could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (report.head) {
    try {
      if (!(await pinnedShaIsAncestor(worktreePath, binding.pinnedSha, options))) {
        drift(`HEAD ${report.head} no longer contains the pinned ${binding.pinnedSha}`)
      }
    } catch (error) {
      unproven(
        `whether HEAD still contains the pinned ${binding.pinnedSha} could not be determined: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (binding.requestedSparseCone.length > 0) {
    try {
      const effectiveCone = await readSparseTaskEffectiveCone(worktreePath, options)
      const uncovered = binding.requestedSparseCone.filter(
        (directory) => !sparseConeCovers(effectiveCone, directory)
      )
      if (uncovered.length > 0) {
        drift(`the effective cone no longer covers ${uncovered.join(', ')}`)
      }
    } catch (error) {
      unproven(
        `the sparse cone could not be read: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  // Why before the path probe: a directory that is not there makes every declared path "missing",
  // which would read as drift. It is not — it may be unmounted, or the workspace may be gone, and
  // neither proves the task workspace was tampered with.
  let directoryPresent = true
  try {
    await stat(worktreePath)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      unproven('the workspace directory is not there')
      directoryPresent = false
    } else {
      unproven(
        `the workspace directory could not be checked: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (directoryPresent && binding.requiredPaths.length > 0) {
    try {
      const check = await verifySparseTaskRequiredPaths({
        worktreePath,
        requiredPaths: binding.requiredPaths
      })
      if (check.missingPaths.length > 0) {
        drift(`declared paths are missing: ${check.missingPaths.join(', ')}`)
      }
      if (check.unverifiablePaths.length > 0) {
        unproven(`declared paths could not be checked: ${check.unverifiablePaths.join(', ')}`)
      }
    } catch (error) {
      unproven(
        `declared paths could not be checked: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  // Why drift wins over unknown: a proven failure is actionable even when another probe was blind.
  if (report.state !== 'drifted' && unknown) {
    report.state = 'unverified'
  }
  return report
}

/** Throwing form of the same decision, for launch paths that must not continue on a bad answer. */
export async function assertTaskWorkspaceReadyToLaunch(args: {
  binding: SparseTaskWorkspaceBinding
  worktreePath: string
  options?: GitWorktreeExecOptions
}): Promise<void> {
  const report = await inspectTaskWorkspaceReadiness(args)
  if (report.state === 'ready') {
    return
  }
  const reason: SparseTaskStartGateReason =
    report.state === 'drifted' ? 'not_ready' : 'unverified'
  throw new SparseTaskStartGateError(
    reason,
    `The task workspace at ${args.worktreePath} is ${report.state}: ${report.reasons.join('; ')}.`
  )
}

/**
 * Read the readiness of a workspace the caller already resolved, without deciding anything.
 *
 * Why the binding decides whether there is anything to check: a workspace without one was not created
 * from a task receipt (legacy full, legacy sparse, external), and `unbound` is exactly the answer for
 * those. A workspace that *claims* a binding it cannot parse is the opposite — a record we must not
 * honour silently.
 */
export async function inspectTaskWorkspaceReadinessFor(args: {
  store: TaskBindingMetaReader | undefined
  workspace: LaunchableTaskWorkspace
  options?: GitWorktreeExecOptions
}): Promise<TaskWorkspaceReadiness> {
  const raw = args.store?.getWorktreeMeta?.(args.workspace.id)?.sparseTaskBinding
  if (raw === undefined) {
    return { state: 'unbound', reasons: [], checkedAt: Date.now() }
  }
  const binding = parseSparseTaskWorkspaceBinding(raw)
  if (!binding) {
    return {
      state: 'binding_invalid',
      reasons: [
        'the stored task binding is not readable as schema v1, so this workspace cannot be proven to be a task workspace'
      ],
      checkedAt: Date.now()
    }
  }
  if (args.workspace.connectionId) {
    // Why its own state: the probe must run on the host that owns the worktree, and v1 is local-only
    // by decision. Reporting `unverified` here would claim a failure nobody observed and would
    // disagree with the launch gate, which lets this case through.
    return {
      state: 'not_probed',
      reasons: ['remote workspaces are not probed in v1 (no host-side probe yet)'],
      pinnedSha: binding.pinnedSha,
      checkedAt: Date.now()
    }
  }
  return await inspectTaskWorkspaceReadiness({
    binding,
    worktreePath: args.workspace.path,
    ...(args.options ? { options: args.options } : {})
  })
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
  const report = await inspectTaskWorkspaceReadinessFor(args)
  if (report.state === 'unbound') {
    return
  }
  if (report.state === 'binding_invalid') {
    throw new SparseTaskStartGateError(
      'binding_invalid',
      `The stored task binding of ${args.workspace.path} is not readable as schema v1, so this workspace cannot be proven to be a task workspace. Check it before launching; nothing was changed.`
    )
  }
  if (report.state === 'ready' || report.state === 'not_probed') {
    return
  }
  throw new SparseTaskStartGateError(
    report.state === 'drifted' ? 'not_ready' : 'unverified',
    `The task workspace at ${args.workspace.path} is ${report.state}: ${report.reasons.join('; ')}.`
  )
}
