// Why its own module (M4): reading back the cone a create actually applied is needed both while
// building the receipt and while adjudicating a create that failed after the fact. Failure to read
// it is never "no cone" — an unread state cannot prove the cone took effect.

import { gitExecFileAsync } from './runner'
import { gitExecOptions, type GitWorktreeExecOptions } from './worktree-operation-options'
import { SparseTaskWorkspaceError } from './sparse-task-workspace-error'

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
export async function readSparseTaskEffectiveCone(
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
