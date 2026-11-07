import {
  SPARSE_TASK_CHECKOUT_MODE,
  type CreateSparseCheckoutRequest,
  type SparseTaskWorkspaceReceipt
} from '../../shared/worktree/create-types'
import { gitExecFileAsync } from '../git/runner'
import { gitExecOptions, type GitWorktreeExecOptions } from '../git/worktree-operation-options'
import { readCreatedWorktreeHead } from './created-worktree-reconciliation'
import { normalizeSparseDirectories } from './sparse-checkout-directories'

/**
 * The task sparse create contract, main side (M1): decide whether a request opted in, refuse the
 * paths that cannot honour it yet, and read the created worktree back before it is reported ready.
 *
 * Every refusal happens before Git creates anything, and every readback runs before metadata,
 * setup or terminals, so a task sparse create never reports success it did not verify.
 */

/** M0 stable codes. The create error channel may only carry `message`, so each is embedded. */
export type SparseTaskWorkspaceErrorCode =
  | 'sparse_task_capability_required'
  | 'sparse_task_head_mismatch'
  | 'sparse_task_effective_cone_mismatch'

export class SparseTaskWorkspaceError extends Error {
  readonly code: SparseTaskWorkspaceErrorCode

  constructor(code: SparseTaskWorkspaceErrorCode, detail: string) {
    super(`[${code}] ${detail}`)
    this.name = 'SparseTaskWorkspaceError'
    this.code = code
  }
}

export type SparseTaskWorkspaceRequest = {
  /** Requested cone, deduplicated in first-seen order. */
  directories: string[]
  /** Declared required paths, exactly as the caller listed them. */
  requiredPaths: string[]
}

/**
 * `null` for every legacy payload. Only an explicit `mode` selects the task contract, so legacy
 * sparse creation keeps its own normalization, rollback and result shape.
 */
export function resolveSparseTaskWorkspaceRequest(
  sparseCheckout: CreateSparseCheckoutRequest | undefined
): SparseTaskWorkspaceRequest | null {
  if (sparseCheckout?.mode !== SPARSE_TASK_CHECKOUT_MODE) {
    return null
  }
  return {
    directories: normalizeSparseDirectories(sparseCheckout.directories),
    requiredPaths: [...(sparseCheckout.requiredPaths ?? [])]
  }
}

/**
 * SSH still runs its own `sparse-checkout` sequence on the executing host and cannot pin or read
 * back yet, so a task request is refused instead of degrading to legacy remote sparse.
 */
export function assertSparseTaskWorkspaceCreatePath(
  request: SparseTaskWorkspaceRequest | null,
  executionHost: 'local' | 'ssh'
): void {
  if (!request || executionHost === 'local') {
    return
  }
  throw new SparseTaskWorkspaceError(
    'sparse_task_capability_required',
    'Task sparse workspaces are not supported for SSH creation yet; create the workspace on a local host or drop sparseCheckout.mode.'
  )
}

/**
 * A task workspace starts a new branch at the pinned commit. Reusing an existing branch would make
 * `actualHead` that branch's head rather than the pin, so the two cannot be combined.
 */
export function assertSparseTaskWorkspaceNewBranch(
  request: SparseTaskWorkspaceRequest | null,
  checkoutExistingBranch: boolean
): void {
  if (!request || !checkoutExistingBranch) {
    return
  }
  throw new SparseTaskWorkspaceError(
    'sparse_task_capability_required',
    'A task sparse workspace creates a new branch; checking out an existing branch is not supported with sparseCheckout.mode.'
  )
}

/**
 * M1 pins the base and reads it back; required-path existence is still unverified here. Refusing a
 * non-empty list keeps a legacy-style success from standing in for a check that did not run.
 */
export function assertSparseTaskRequiredPathsSupported(
  request: SparseTaskWorkspaceRequest | null
): void {
  if (!request || request.requiredPaths.length === 0) {
    return
  }
  throw new SparseTaskWorkspaceError(
    'sparse_task_capability_required',
    'requiredPaths cannot be verified by this host yet; a task sparse create must not return success without checking them.'
  )
}

/** The pinned base a receipt reports: what the caller asked for, resolved to one commit. */
export type SparseTaskWorkspacePin = {
  baseSource: 'request' | 'default'
  resolvedRef: string
  pinnedSha: string
}

/**
 * Cone mode collapses a requested child into an ancestor entry and never lists descendants, so a
 * request is satisfied when some effective entry is it or one of its ancestors.
 */
export function sparseConeCovers(
  effectiveSparseCone: readonly string[],
  directory: string
): boolean {
  return effectiveSparseCone.some(
    (entry) => entry === directory || directory.startsWith(`${entry}/`)
  )
}

/**
 * Read back the cone Git actually applied.
 *
 * Why not the pattern file or `core.sparseCheckout`: both say sparse was configured, not which
 * directories are selected. Failing to read the list is treated as a mismatch because an unread
 * state cannot prove the cone took effect.
 */
export async function readWorktreeSparseCone(
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<string[]> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['sparse-checkout', 'list'],
      gitExecOptions(worktreePath, options)
    )
    return stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith('#'))
  } catch (error) {
    throw new SparseTaskWorkspaceError(
      'sparse_task_effective_cone_mismatch',
      `Could not read back the sparse cone of ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Verify the created worktree and build its receipt. Throws rather than returning a partial
 * receipt: HEAD must be the pin, and the effective cone must still cover what was requested.
 *
 * The worktree is intentionally left in place on failure — M1 reports, it does not clean up.
 */
export async function buildSparseTaskWorkspaceReceipt(args: {
  worktreePath: string
  branch: string
  pin: SparseTaskWorkspacePin
  requestedSparseCone: readonly string[]
  options?: GitWorktreeExecOptions
}): Promise<SparseTaskWorkspaceReceipt> {
  const actualHead = await readCreatedWorktreeHead(args.worktreePath, args.options)
  if (actualHead.toLowerCase() !== args.pin.pinnedSha.toLowerCase()) {
    throw new SparseTaskWorkspaceError(
      'sparse_task_head_mismatch',
      `The worktree at ${args.worktreePath} (branch ${args.branch}) is at ${actualHead}, not the pinned ${args.pin.pinnedSha}.`
    )
  }
  const effectiveSparseCone = await readWorktreeSparseCone(args.worktreePath, args.options)
  const uncovered = args.requestedSparseCone.filter(
    (directory) => !sparseConeCovers(effectiveSparseCone, directory)
  )
  if (uncovered.length > 0) {
    throw new SparseTaskWorkspaceError(
      'sparse_task_effective_cone_mismatch',
      `The worktree at ${args.worktreePath} has no effective sparse entry for ${uncovered.join(', ')}.`
    )
  }
  return {
    baseSource: args.pin.baseSource,
    resolvedRef: args.pin.resolvedRef,
    pinnedSha: args.pin.pinnedSha,
    actualHead,
    requestedSparseCone: [...args.requestedSparseCone],
    effectiveSparseCone
  }
}
