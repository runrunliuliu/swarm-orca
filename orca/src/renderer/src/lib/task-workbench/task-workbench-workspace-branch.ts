import type { DashboardCardWorkspaceKind } from '../../../../shared/dashboard-snapshot'

/**
 * The branch a workspace identity may print, or `undefined` when there is none
 * (README §7.4.2 取舍 2).
 *
 * Why this is its own pure module: the rule "a workspace identity names a branch,
 * never the display name Orca derived from the task title" has one exception that
 * is a data-leak risk rather than a copy preference — a folder workspace carries a
 * directory path in `Worktree.branch`, and printing it would put a home directory
 * on screen under the label "branch". Keeping the rule here, out of the
 * store-reading hook, is what makes that exception testable at all.
 *
 * Two absences, both rendered as "no branch": the row is a folder workspace, or
 * the branch is the empty string (a worktree discovered on disk before Git
 * reported a head). Neither is a name, so neither may become one.
 */
export function workspaceBranchName(
  workspaceKind: DashboardCardWorkspaceKind | undefined,
  worktree: { branch?: string | null }
): string | undefined {
  if (workspaceKind === 'folder' || !worktree.branch) {
    return undefined
  }
  return worktree.branch
}
