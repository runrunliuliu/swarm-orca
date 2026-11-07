// M4 (minimum): adjudicate a task create that ended without a receipt, and mark it for a human.
//
// Why a separate module: `git worktree add` can be killed by a timeout, an abort or a lost response
// while Git keeps writing on the host. The reader below answers only what the repository and the
// filesystem can prove, in three honest shapes — nothing is there, something is there, neither can
// be proven — and never deletes, widens a cone or repairs a workspace.

import { stat } from 'node:fs/promises'
import { listWorktreesSharedStrict } from '../git/worktree'
import { verifySparseTaskRequiredPaths } from '../git/sparse-task-required-paths'
import {
  readSparseTaskEffectiveCone,
  sparseConeCovers
} from '../git/sparse-task-sparse-state'
import type { GitWorktreeExecOptions } from '../git/worktree-operation-options'
import {
  findCreatedWorktree,
  readCreatedWorktreeHead
} from './created-worktree-reconciliation'

export type SparseTaskCreateObservedState = 'live' | 'partial' | 'absent' | 'unverifiable'

export type SparseTaskCreateInspection = {
  state: SparseTaskCreateObservedState
  worktreePath: string
  branch: string
  pinnedSha: string
  registered: boolean
  /** Git still lists the registration while the directory is gone — the ghost the runbook names. */
  ghostRegistration: boolean
  directoryExists: boolean
  head?: string
  headMatchesPin?: boolean
  effectiveSparseCone?: string[]
  missingRequiredPaths?: string[]
  unverifiableRequiredPaths?: string[]
  /** Why the state is what it is; empty only for `live` and `absent`. */
  reasons: string[]
}

/** Stable code carrying the marker; the create error channel may only carry message text. */
export const SPARSE_TASK_RECONCILIATION_CODE = 'sparse_task_create_needs_reconciliation'

// Why bounded separately: an inspection runs when a create is already suspect, so it must not
// inherit a three-minute `worktree add` budget (or the abort that made the outcome unknown).
const SPARSE_TASK_INSPECTION_TIMEOUT_MS = 10_000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Adjudicate a failed task create from the repository and the filesystem.
 *
 * Why after a failure: `git worktree add` can be killed by a timeout, an abort or a lost response
 * while Git keeps writing on the host. The caller then holds an error and no receipt, so the only
 * honest answers are "nothing is there", "something is there" and "I could not prove either".
 */
export async function inspectSparseTaskCreate(args: {
  repoPath: string
  worktreePath: string
  branch: string
  pin: { pinnedSha: string }
  requestedSparseCone: readonly string[]
  requiredPaths: readonly string[]
  options?: GitWorktreeExecOptions
}): Promise<SparseTaskCreateInspection> {
  // Why drop the caller's abort signal: an aborted request is exactly when this has to answer.
  const { signal: _signal, ...execOptions } = args.options ?? {}
  const options: GitWorktreeExecOptions = {
    ...execOptions,
    timeout: SPARSE_TASK_INSPECTION_TIMEOUT_MS
  }
  const inspection: SparseTaskCreateInspection = {
    state: 'unverifiable',
    worktreePath: args.worktreePath,
    branch: args.branch,
    pinnedSha: args.pin.pinnedSha,
    registered: false,
    ghostRegistration: false,
    directoryExists: false,
    reasons: []
  }
  const listingUnknown = (): void => {
    inspection.reasons.push('repo listing could not be read')
  }
  try {
    const worktrees = await listWorktreesSharedStrict(args.repoPath, options)
    inspection.registered = Boolean(
      findCreatedWorktree(worktrees, args.worktreePath, args.branch)
    )
  } catch {
    listingUnknown()
  }
  inspection.directoryExists = await pathExists(args.worktreePath)
  // Why ghost: a registration without a directory is what a killed writer leaves, and it is also
  // what makes a later `worktree add` refuse the name — it has to be visible, not silent.
  inspection.ghostRegistration = inspection.registered && !inspection.directoryExists
  if (!inspection.registered && !inspection.directoryExists) {
    inspection.state = 'absent'
    return inspection
  }
  if (!inspection.directoryExists) {
    inspection.state = 'partial'
    inspection.reasons.push('registered but the directory is missing')
    return inspection
  }
  let unknown = false
  try {
    inspection.head = await readCreatedWorktreeHead(args.worktreePath, options)
    inspection.headMatchesPin =
      inspection.head.toLowerCase() === args.pin.pinnedSha.toLowerCase()
    if (!inspection.headMatchesPin) {
      inspection.reasons.push(`HEAD ${inspection.head} is not the pinned ${args.pin.pinnedSha}`)
    }
  } catch {
    unknown = true
    inspection.reasons.push('HEAD could not be read')
  }
  try {
    inspection.effectiveSparseCone = await readSparseTaskEffectiveCone(args.worktreePath, options)
    const uncovered = args.requestedSparseCone.filter(
      (directory) => !sparseConeCovers(inspection.effectiveSparseCone ?? [], directory)
    )
    if (uncovered.length > 0) {
      inspection.reasons.push(`no effective sparse entry for ${uncovered.join(', ')}`)
    }
  } catch {
    unknown = true
    inspection.reasons.push('the sparse cone could not be read back')
  }
  try {
    const requiredPathCheck = await verifySparseTaskRequiredPaths({
      worktreePath: args.worktreePath,
      requiredPaths: args.requiredPaths
    })
    inspection.missingRequiredPaths = requiredPathCheck.missingPaths
    inspection.unverifiableRequiredPaths = requiredPathCheck.unverifiablePaths
    if (requiredPathCheck.missingPaths.length > 0) {
      inspection.reasons.push(
        `required paths missing: ${requiredPathCheck.missingPaths.join(', ')}`
      )
    }
    if (requiredPathCheck.unverifiablePaths.length > 0) {
      unknown = true
      inspection.reasons.push(
        `required paths unverifiable: ${requiredPathCheck.unverifiablePaths.join(', ')}`
      )
    }
  } catch {
    unknown = true
    inspection.reasons.push('required paths could not be checked')
  }
  if (!inspection.registered) {
    inspection.reasons.push('the worktree directory exists but is not in the repo listing')
  }
  inspection.state = unknown
    ? 'unverifiable'
    : inspection.reasons.length === 0
      ? 'live'
      : 'partial'
  return inspection
}

/**
 * Turn a failure with leftovers into one callers can act on: stable code first, then the coordinates
 * and observed state. The original error stays attached as `cause`, and its own code survives.
 */
export function markSparseTaskCreateNeedsReconciliation(args: {
  error: unknown
  inspection: SparseTaskCreateInspection
}): Error {
  const { inspection } = args
  const original = args.error
  const detail = [
    `observed ${inspection.state}`,
    `worktree ${inspection.worktreePath}`,
    `branch ${inspection.branch}`,
    `pinned ${inspection.pinnedSha}`,
    `head ${inspection.head ?? 'unknown'}`,
    `directory ${inspection.directoryExists ? 'present' : 'missing'}`,
    inspection.ghostRegistration ? 'registration ghost' : 'registration listed',
    ...(inspection.missingRequiredPaths && inspection.missingRequiredPaths.length > 0
      ? [`missing required paths ${inspection.missingRequiredPaths.join(', ')}`]
      : []),
    ...inspection.reasons
  ]
  const marked = new Error(
    `[${SPARSE_TASK_RECONCILIATION_CODE}] ${message(original)} —${detail.length > 0 ? ` ${detail.join('; ')}` : ''}. Nothing was deleted; check this workspace before retrying.`,
    { cause: original }
  )
  // Why carry the inner code: callers already switch on `[sparse_task_*]` codes, and the marker
  // must not hide which gate refused the create.
  const originalCode =
    typeof original === 'object' && original !== null && 'code' in original
      ? original.code
      : undefined
  if (typeof originalCode === 'string' && originalCode.startsWith('sparse_task_')) {
    ;(marked as Error & { code?: string }).code = originalCode
  }
  return marked
}

/** Whether a create failure is the "something may be left behind" marker. */
export function isSparseTaskCreateNeedsReconciliation(error: unknown): boolean {
  return message(error).includes(`[${SPARSE_TASK_RECONCILIATION_CODE}]`)
}

