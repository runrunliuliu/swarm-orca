import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { normalizeLocalBranchRef } from './worktree-operation-options'
import { listWorktreeGraph } from './worktree-listing'
import { areWorktreePathsEqual } from './worktree-path-comparison'

// Why: the create already spent its whole budget; verifying it must not add a second one.
const TIMED_OUT_ADD_RECONCILE_TIMEOUT_MS = 5_000

/**
 * Whether `git worktree add` finished the checkout between its deadline and this read.
 *
 * A deadline only ends our wait: Git keeps filling the checkout, and `locked initializing` is Git's
 * own marker for an add that is still running. Adopting an unlocked row keeps a checkout that
 * finished a moment too late; anything else stays unresolved, so the caller reports the timeout
 * instead of deleting work in progress.
 */
export async function readWorktreeAddCompletedAfterDeadline(
  repoPath: string,
  worktreePath: string,
  branch: string,
  options: GitWorktreeExecOptions = {}
): Promise<boolean> {
  const expectedBranch = `refs/heads/${normalizeLocalBranchRef(branch)}`
  try {
    const worktrees = await listWorktreeGraph(repoPath, {
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      timeout: TIMED_OUT_ADD_RECONCILE_TIMEOUT_MS
    })
    return worktrees.some(
      (worktree) =>
        areWorktreePathsEqual(worktree.path, worktreePath) &&
        worktree.branch === expectedBranch &&
        // Why both: a locked row is still initializing, a prunable one lost its directory.
        worktree.locked !== true &&
        worktree.prunable !== true
    )
  } catch (error) {
    // Why: an unverifiable checkout is not a completed one; the caller rethrows the original timeout.
    console.warn(`[git/worktree] could not verify the timed-out add for "${worktreePath}"`, error)
    return false
  }
}
