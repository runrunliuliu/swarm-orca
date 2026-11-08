import {
  SPARSE_TASK_CHECKOUT_MODE,
  type CreateSparseCheckoutRequest,
  type SparseTaskWorkspaceReceipt
} from '../../shared/worktree/create-types'
import { gitExecFileAsyncBuffer } from '../git/runner'
import type {
  AddWorktreeResult,
  GitWorktreeExecOptions
} from '../git/worktree-operation-options'
import { resolvePinnedWorktreeBase } from '../git/worktree-add'
import {
  parseSparseTaskDirectories,
  parseSparseTaskRequiredPaths
} from '../git/sparse-task-input-validation'
import {
  assertSparseTaskRequiredPathsPresent,
  verifySparseTaskRequiredPaths
} from '../git/sparse-task-required-paths'
import {
  SPARSE_TASK_MAX_TREE_PROBE_BYTES,
  assertSparseTaskPinnedSha,
  buildSparseTaskTreeProbeArgs,
  parseSparseTaskTreeListing,
  validateSparseTaskDirectoriesAgainstPinnedTree,
  type SparseTaskDirectoryTreeCheck
} from '../git/sparse-task-tree-validation'
import { SparseTaskValidationError } from '../git/sparse-task-input-validation'
import {
  readSparseTaskEffectiveCone,
  sparseConeCovers
} from '../git/sparse-task-sparse-state'
import { SparseTaskWorkspaceError } from '../git/sparse-task-workspace-error'
import {
  readCreatedWorktreeHead,
  resolveCreatedWorktree,
  type CreatedWorktreeResolution
} from './created-worktree-reconciliation'
import {
  inspectSparseTaskCreate,
  markSparseTaskCreateNeedsReconciliation
} from './sparse-task-create-reconciliation'
import {
  beginSparseTaskCreate,
  settleSparseTaskCreate
} from './sparse-task-create-journal'

// Why re-exported: this module's callers and tests reach the cone rule through the create contract,
// and moving the implementation must not move the seam.
export { sparseConeCovers }

/**
 * The task sparse create contract on the calling side: decide whether a request opted in, refuse
 * before any Git side effect what the path cannot honour, resolve one pinned commit, verify it
 * against the requested cone, and only then build the receipt the caller may trust.
 *
 * Refusals carry a `[code]` in `message` because the create error channel may only carry text. The
 * three codes below are this module's own; the M2 rule modules throw `SparseTaskValidationError`
 * with the same bracketed convention.
 */

export type SparseTaskWorkspaceRequest = {
  /** Strictly parsed request cone, deduplicated in first-seen order. */
  directories: string[]
  /** Strictly parsed required paths; verified after creation, never before. */
  requiredPaths: string[]
}

/**
 * `null` for every legacy payload. Only an explicit `mode` selects the task contract, so a legacy
 * sparse create keeps its own trimming/dedupe, its rollback, and its result shape. The strict rules
 * apply from here on: no legacy normalization is mixed into the task path.
 */
export function resolveSparseTaskWorkspaceRequest(
  sparseCheckout: CreateSparseCheckoutRequest | undefined
): SparseTaskWorkspaceRequest | null {
  if (sparseCheckout?.mode !== SPARSE_TASK_CHECKOUT_MODE) {
    return null
  }
  return {
    directories: parseSparseTaskDirectories(sparseCheckout.directories),
    requiredPaths: parseSparseTaskRequiredPaths(sparseCheckout.requiredPaths ?? [])
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
 * Why refuse a setup decision at all: a repository's setup hook assumes a full checkout —
 * `pnpm install`, codegen, writing `node_modules` — and a task workspace deliberately materializes
 * only its cone. Running it there fails obscurely, or writes into paths the cone never restores.
 * M0 already said the first task sparse version runs with setup skipped; this puts that rule in the
 * host instead of trusting every caller (desktop, mobile, CLI, future ones) to send it.
 */
export function assertSparseTaskSetupSkipped(
  request: SparseTaskWorkspaceRequest | null,
  args: { setupDecision?: 'run' | 'skip' | 'inherit'; runHooks?: boolean }
): void {
  if (!request) {
    return
  }
  // Why `--run-hooks` counts: it forces `run` regardless of the recorded decision.
  const decision = args.runHooks === true ? 'run' : (args.setupDecision ?? 'inherit')
  if (decision === 'skip') {
    return
  }
  throw new SparseTaskWorkspaceError(
    'sparse_task_capability_required',
    `Task sparse workspaces are created with setup skipped, but this request asked for "${decision}". Create the workspace with --setup skip, then run any setup yourself if the task needs it. Nothing was created.`
  )
}

/** The pinned base a receipt reports: what the caller asked for, resolved to one commit. */
export type SparseTaskWorkspacePin = {
  baseSource: 'request' | 'default'
  resolvedRef: string
  pinnedSha: string
}

/**
 * Resolve the base once and hand back only a normalized full commit id.
 *
 * One resolution point for both create paths, so the SHA that gates the tree probe, the
 * `worktree add` target and the HEAD comparison cannot be three different strings.
 */
export async function pinSparseTaskWorkspaceBase(args: {
  repoPath: string
  baseBranch: string
  baseSource: 'request' | 'default'
  options?: GitWorktreeExecOptions
}): Promise<SparseTaskWorkspacePin> {
  const pin = await resolvePinnedWorktreeBase(args.repoPath, args.baseBranch, args.options)
  return {
    baseSource: args.baseSource,
    resolvedRef: pin.resolvedRef,
    // Why assert here: `resolvePinnedWorktreeBase` reports whatever Git printed; the task contract
    // only accepts a full commit id, in the lowercase form later HEAD comparisons expect.
    pinnedSha: assertSparseTaskPinnedSha(pin.pinnedSha)
  }
}

/**
 * Prove every requested directory is a real tree in the pinned commit, before anything is created.
 *
 * Runs against the repository, from the pinned commit — never the new worktree (it does not exist
 * yet) and never the source checkout (it may itself be sparse).
 */
export async function verifySparseTaskWorkspacePinnedTree(args: {
  repoPath: string
  pin: Pick<SparseTaskWorkspacePin, 'pinnedSha'>
  requestedSparseCone: readonly string[]
  options?: GitWorktreeExecOptions
}): Promise<SparseTaskDirectoryTreeCheck> {
  const probeArgs = buildSparseTaskTreeProbeArgs({
    pinnedSha: args.pin.pinnedSha,
    requestedDirectories: args.requestedSparseCone
  })
  let stdout: Uint8Array
  try {
    // Why the buffer runner: `ls-tree -z` output must reach the parser as raw bytes (no lossy UTF-8
    // decode, no WSL path translation), and the probe is bounded before it can be parsed.
    ;({ stdout } = await gitExecFileAsyncBuffer(probeArgs, {
      cwd: args.repoPath,
      ...(args.options?.wslDistro ? { wslDistro: args.options.wslDistro } : {}),
      ...(args.options?.admissionTier ? { admissionTier: args.options.admissionTier } : {}),
      maxBuffer: SPARSE_TASK_MAX_TREE_PROBE_BYTES
    }))
  } catch (error) {
    // Why a probe code: an unreadable tree is "cannot prove", not "the directory is absent".
    throw new SparseTaskValidationError(
      'sparse_task_tree_probe_invalid',
      `Reading the pinned tree of ${args.repoPath} failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return validateSparseTaskDirectoriesAgainstPinnedTree({
    pinnedSha: args.pin.pinnedSha,
    requestedDirectories: args.requestedSparseCone,
    treeEntries: parseSparseTaskTreeListing(stdout)
  })
}

/**
 * Verify the created worktree and build its receipt. Throws rather than returning a partial receipt.
 *
 * Order matters and is the M2 contract: HEAD must be the pin, the effective cone must still cover
 * what was requested, and only then are the declared required paths checked inside that workspace —
 * a path can only be judged in the workspace the pin actually produced. Nothing here widens the
 * cone, falls back to a full checkout, or cleans up: the worktree is left in place for inspection.
 */
export async function buildSparseTaskWorkspaceReceipt(args: {
  worktreePath: string
  branch: string
  pin: SparseTaskWorkspacePin
  requestedSparseCone: readonly string[]
  requiredPaths: readonly string[]
  options?: GitWorktreeExecOptions
}): Promise<SparseTaskWorkspaceReceipt> {
  const actualHead = await readCreatedWorktreeHead(args.worktreePath, args.options)
  if (actualHead.toLowerCase() !== args.pin.pinnedSha.toLowerCase()) {
    throw new SparseTaskWorkspaceError(
      'sparse_task_head_mismatch',
      `The worktree at ${args.worktreePath} (branch ${args.branch}) is at ${actualHead}, not the pinned ${args.pin.pinnedSha}.`
    )
  }
  const effectiveSparseCone = await readSparseTaskEffectiveCone(args.worktreePath, args.options)
  const uncovered = args.requestedSparseCone.filter(
    (directory) => !sparseConeCovers(effectiveSparseCone, directory)
  )
  if (uncovered.length > 0) {
    throw new SparseTaskWorkspaceError(
      'sparse_task_effective_cone_mismatch',
      `The worktree at ${args.worktreePath} has no effective sparse entry for ${uncovered.join(', ')}.`
    )
  }
  const requiredPathCheck = await verifySparseTaskRequiredPaths({
    worktreePath: args.worktreePath,
    requiredPaths: args.requiredPaths
  })
  assertSparseTaskRequiredPathsPresent(requiredPathCheck)
  return {
    baseSource: args.pin.baseSource,
    resolvedRef: args.pin.resolvedRef,
    pinnedSha: args.pin.pinnedSha,
    actualHead,
    requestedSparseCone: [...args.requestedSparseCone],
    effectiveSparseCone,
    requiredPaths: requiredPathCheck.requiredPaths
  }
}

/** What one task sparse create produced, in the order the gates ran. */
export type SparseTaskWorkspaceCreateOutcome = {
  resolution: CreatedWorktreeResolution
  addResult: AddWorktreeResult
  receipt: SparseTaskWorkspaceReceipt
}

/** The task sparse create sequence, defined once for both local create paths. Callers pass only
 *  what differs: how to add a worktree, what to do once it exists, and whether to record timings. */
export async function createSparseTaskWorkspace(args: {
  /** When present, the attempt is journalled before the first side effect (M4 intent record). */
  repoId?: string
  repoPath: string
  worktreePath: string
  branch: string
  baseBranch: string
  baseSource: 'request' | 'default'
  request: SparseTaskWorkspaceRequest
  options: GitWorktreeExecOptions
  addWorktreeAtPin: (pin: SparseTaskWorkspacePin) => Promise<AddWorktreeResult>
  worktreeCreated?: (addResult: AddWorktreeResult) => Promise<void>
  phase?: <T>(name: string, run: () => Promise<T>) => Promise<T>
}): Promise<SparseTaskWorkspaceCreateOutcome> {
  const phase = args.phase ?? (<T>(_name: string, run: () => Promise<T>) => run())
  const { directories, requiredPaths } = args.request
  const pin = await phase('pin_base', () =>
    pinSparseTaskWorkspaceBase({
      repoPath: args.repoPath,
      baseBranch: args.baseBranch,
      baseSource: args.baseSource,
      options: args.options
    })
  )
  // Why before the add: every requested directory must be a tree in the pinned commit before a
  // worktree exists, proved by reading the repository at that commit (never the future worktree).
  await phase('verify_sparse_task_pinned_tree', () =>
    verifySparseTaskWorkspacePinnedTree({
      repoPath: args.repoPath,
      pin,
      requestedSparseCone: directories,
      options: args.options
    })
  )
  // Why before the first side effect: if the intent cannot be recorded, a create that later times
  // out would leave a workspace nobody can trace. Refusing here is cheaper than that.
  const journal = args.repoId
    ? await beginSparseTaskCreate({
        repoId: args.repoId,
        repoPath: args.repoPath,
        worktreePath: args.worktreePath,
        branch: args.branch,
        pinnedSha: pin.pinnedSha,
        requestedSparseCone: directories,
        requiredPaths
      })
    : undefined
  const settle = async (
    state: 'created' | 'failed' | 'needs_reconciliation',
    reasons?: readonly string[]
  ): Promise<void> => {
    if (!journal || !args.repoId) {
      return
    }
    await settleSparseTaskCreate({
      repoId: args.repoId,
      requestId: journal.requestId,
      state,
      ...(reasons ? { reasons } : {})
    })
  }
  // Why the try starts here: `git worktree add` is the first side effect, and every failure after
  // it can leave a directory, a branch or a registration behind even when the caller sees an error.
  try {
    const addResult = (await args.addWorktreeAtPin(pin)) ?? {}
    await args.worktreeCreated?.(addResult)
    const resolution = await phase('list_created_worktree', () =>
      resolveCreatedWorktree(args.repoPath, args.worktreePath, args.branch, args.options)
    )
    // Why before any metadata: a workspace whose HEAD or cone does not match the pin, or that is
    // missing a declared required path, must not be published as ready.
    const receipt = await phase('verify_sparse_task_workspace', () =>
      buildSparseTaskWorkspaceReceipt({
        worktreePath: resolution.created.path,
        branch: args.branch,
        pin,
        requestedSparseCone: directories,
        requiredPaths,
        options: args.options
      })
    )
    await settle('created')
    return { resolution, addResult, receipt }
  } catch (error) {
    // Why inspect instead of assuming: the create may have been aborted or answered too late, so
    // the error alone cannot say whether a workspace exists. Only real leftovers get a marker; a
    // clean refusal keeps its original error and stays retryable.
    const inspection = await inspectSparseTaskCreate({
      repoPath: args.repoPath,
      worktreePath: args.worktreePath,
      branch: args.branch,
      pin,
      requestedSparseCone: directories,
      requiredPaths,
      options: args.options
    }).catch(() => undefined)
    const detail = error instanceof Error ? error.message : String(error)
    if (!inspection || inspection.state === 'absent') {
      await settle('failed', [detail])
      throw error
    }
    const marked = markSparseTaskCreateNeedsReconciliation({ error, inspection })
    await settle('needs_reconciliation', [detail, ...inspection.reasons])
    throw marked
  }
}
