// Why (M2): declaring how much a task needs to read is not the same as having it. This module
// verifies the declared paths inside the created worktree and reports gaps — it never widens the
// sparse cone, never falls back to a full checkout, and never fabricates a missing file.

import { stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  SparseTaskValidationError,
  parseSparseTaskRequiredPaths
} from './sparse-task-input-validation'

/** `present` is positive evidence; `unverifiable` is not evidence of absence either way. */
export type SparseTaskPathVerdict = 'present' | 'missing' | 'unverifiable'

/** Injected so a WSL/SSH-hosted check can answer on the host that owns the worktree. */
export type SparseTaskPathProbe = (absolutePath: string) => Promise<SparseTaskPathVerdict>

export type SparseTaskRequiredPathCheck = {
  worktreePath: string
  /** Strictly parsed declarations, first-occurrence order, deduplicated. */
  requiredPaths: string[]
  /** Declared paths with no filesystem entry (ENOENT/ENOTDIR). */
  missingPaths: string[]
  /** Declared paths whose existence could not be established (permission, loop, I/O). */
  unverifiablePaths: string[]
}

// Why: a worktree may name hundreds of required paths; overlap the independent local stats
// without flooding the filesystem threadpool.
const REQUIRED_PATH_PROBE_CONCURRENCY = 8
const MAX_PATHS_IN_MESSAGE = 10

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/** Default probe: `stat` follows links, so a dangling symlink reports missing rather than
 *  "present but unusable". Anything other than a definitive ENOENT/ENOTDIR stays unverifiable. */
export async function statSparseTaskPath(absolutePath: string): Promise<SparseTaskPathVerdict> {
  try {
    await stat(absolutePath)
    return 'present'
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unverifiable'
  }
}

function requireAbsoluteWorktreePath(worktreePath: string): string {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0 || !isAbsolute(worktreePath)) {
    throw new Error(
      `Sparse task required-path check needs a non-empty absolute worktree path, got ${JSON.stringify(worktreePath)}.`
    )
  }
  return resolve(worktreePath)
}

function absolutePathWithinWorktree(root: string, relativePath: string): string {
  const absolutePath = resolve(root, relativePath)
  // Why: strict parsing already refuses `..` and absolute forms; this asserts the invariant
  // instead of silently reading outside the worktree if that rule is ever relaxed.
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Required path ${JSON.stringify(relativePath)} escapes ${root}.`)
  }
  return absolutePath
}

/**
 * Checks declared required paths inside `worktreePath`. The result is evidence, not a gate:
 * callers decide, and `assertSparseTaskRequiredPathsPresent` is the fail-closed default.
 */
export async function verifySparseTaskRequiredPaths(input: {
  worktreePath: string
  requiredPaths: readonly string[]
  probe?: SparseTaskPathProbe
}): Promise<SparseTaskRequiredPathCheck> {
  const root = requireAbsoluteWorktreePath(input.worktreePath)
  const requiredPaths = parseSparseTaskRequiredPaths(input.requiredPaths)
  const probe = input.probe ?? statSparseTaskPath
  const verdicts = await mapWithConcurrency(
    requiredPaths,
    REQUIRED_PATH_PROBE_CONCURRENCY,
    async (requiredPath) => {
      const absolutePath = absolutePathWithinWorktree(root, requiredPath)
      try {
        return await probe(absolutePath)
      } catch {
        // Why: a probe that threw (transport, adapter, permission) has not proven absence —
        // unverifiable keeps the fail-closed outcome distinguishable from missing.
        return 'unverifiable'
      }
    }
  )
  const missingPaths: string[] = []
  const unverifiablePaths: string[] = []
  for (const [index, verdict] of verdicts.entries()) {
    if (verdict === 'missing') {
      missingPaths.push(requiredPaths[index])
    } else if (verdict === 'unverifiable') {
      unverifiablePaths.push(requiredPaths[index])
    }
  }
  return { worktreePath: root, requiredPaths, missingPaths, unverifiablePaths }
}

function describePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_PATHS_IN_MESSAGE).map((path) => JSON.stringify(path))
  const rest = paths.length - shown.length
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ')
}

/** Fail-closed default for wiring: any gap refuses readiness.
 *  `unverifiable` reuses the missing code because M0 defines no separate one; the message and
 *  `SparseTaskRequiredPathCheck` keep the two cases distinguishable. */
export function assertSparseTaskRequiredPathsPresent(check: SparseTaskRequiredPathCheck): void {
  if (check.missingPaths.length === 0 && check.unverifiablePaths.length === 0) {
    return
  }
  const reasons: string[] = []
  if (check.missingPaths.length > 0) {
    reasons.push(`missing ${describePaths(check.missingPaths)}`)
  }
  if (check.unverifiablePaths.length > 0) {
    reasons.push(`could not verify ${describePaths(check.unverifiablePaths)}`)
  }
  throw new SparseTaskValidationError(
    'sparse_task_required_path_missing',
    `Required paths are not available in ${check.worktreePath}: ${reasons.join('; ')}.`
  )
}
