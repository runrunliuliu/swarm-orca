import { readGitCommandFailureText } from '../../shared/git-command-failure-text'
import { forceDeleteLocalBranch } from './worktree-branch-removal'
import { gitExecFileAsync } from './runner'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'

/** `-b` refuses before writing anything when the ref exists, so that branch is not ours to delete. */
function isBranchRefusal(error: unknown): boolean {
  return /a branch named ['"].*['"] already exists/i.test(readGitCommandFailureText(error))
}

/**
 * Delete the branch `git worktree add -b` created when the add itself failed.
 *
 * Git removes the worktree directory and its admin entry on failure but leaves the branch, so a
 * failed create would otherwise block every retry with a branch no workspace names. Only a branch
 * still sitting on the exact commit this create started from is deleted: any other tip holds work.
 */
export async function deleteBranchLeftByFailedWorktreeAdd(
  repoPath: string,
  branchName: string,
  startPoint: string | undefined,
  error: unknown,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  if (isBranchRefusal(error)) {
    return
  }
  const runGit = (args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> =>
    gitExecFileAsync(args, gitExecOptions(cwd, options))
  try {
    const branchHead = await readCommitOid(runGit, repoPath, `refs/heads/${branchName}`)
    const startOid = await readCommitOid(runGit, repoPath, `${startPoint ?? 'HEAD'}^{commit}`)
    if (!branchHead || branchHead !== startOid) {
      return
    }
    // Why: refuses a branch another worktree holds, and deletes only while the ref still matches.
    await forceDeleteLocalBranch(repoPath, branchName, branchHead, runGit)
  } catch (cleanupError) {
    // Why: the create already failed; a branch that cannot be proven unused is reported, never forced.
    console.warn(
      `[git/worktree] kept local branch "${branchName}" after a failed worktree add`,
      cleanupError
    )
  }
}

async function readCommitOid(
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string }>,
  repoPath: string,
  ref: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', ref], repoPath)
    return stdout.trim() || null
  } catch {
    // Why: a missing ref is the normal case when Git never created the branch.
    return null
  }
}
