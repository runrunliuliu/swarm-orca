import type { Worktree } from '../../../shared/worktree/types'

/**
 * The repo's own checkout — the first entry of `git worktree list` — as opposed to the branch
 * worktrees `+ → Create workspace` makes. Starting an agent there needs no branch and no new
 * checkout, which is what the project row's "open agent" action is for.
 *
 * Pure on purpose: the caller decides what a missing checkout means (the sidebar toasts).
 */
export function findRepoCheckoutWorktree(
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>,
  repoId: string
): Worktree | null {
  return worktreesByRepo[repoId]?.find((worktree) => worktree.isMainWorktree) ?? null
}
