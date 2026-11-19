import { LOCAL_EXECUTION_HOST_ID, getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { JoinWorktree } from '@/lib/task-workbench/task-workbench-selector-types'
import { workspaceBranchName } from '@/lib/task-workbench/task-workbench-workspace-branch'
import { boundedLabel } from './dashboard-card-labels'
import { readDashboardClientHost } from './dashboard-client-host'
import { dashboardCardMapWorkspaceMetadata } from './dashboard-snapshot-workspaces'

/**
 * The workspace value for a row the snapshot does not carry — an archived
 * worktree, or defensively an active one past `DASHBOARD_MAX_MAP_WORKSPACES`.
 * The host fields come from the same two helpers the snapshot uses, so an
 * archived remote workspace resolves to its real host instead of coming out
 * local.
 *
 * Deliberately not filled in for these rows: `workspaceStatus*`, `hasReview`,
 * `review` (their source is the card-side context, which the snapshot only
 * projects for active rows) and `hostLabel` (a module-private saved-host label
 * lookup). The archived fold therefore shows repo · worktree, the archived and
 * host-kind badges and nothing else — an addition for archived rows, not a
 * regression against the snapshot the active rows get. `parentWorktreeId` is
 * out for the same reason the dashboard needs a widened row type to read it:
 * the `Worktree` type does not declare it.
 *
 * Split out of `use-task-workbench-view.ts` when issue #31 widened that hook
 * past its `max-lines` budget; the projection is unchanged.
 */
export function projectMissingWorkspace(
  repo: Repo | undefined,
  worktree: Worktree
): JoinWorktree {
  const executionHostId = getWorktreeExecutionHostId(worktree, repo)
  const isRemote = executionHostId !== LOCAL_EXECUTION_HOST_ID
  const metadata = dashboardCardMapWorkspaceMetadata(
    {
      projectId: worktree.repoId,
      projectName: repo?.displayName ?? worktree.repoId,
      repo: repo ?? null,
      repoIcon: repo?.repoIcon ?? null,
      worktree,
      workspaceKind: repo && isFolderRepo(repo) ? 'folder' : 'worktree',
      // The one line restated from `dashboard-snapshot-workspaces.ts:62-68`
      // (private there). It decides `hostKind`, and an archived SSH workspace
      // must not render as local.
      remoteHostKind: !isRemote
        ? null
        : repo?.connectionId || executionHostId.startsWith('ssh:')
          ? 'ssh'
          : 'remote'
    },
    // No live pty and no terminal input on these rows, so the platform branch
    // that reads `clientPlatform` (wsl) cannot fire and this read stays inert.
    null,
    undefined,
    readDashboardClientHost().platform
  )
  const branchName = workspaceBranchName(metadata.workspaceKind, worktree)
  return {
    repoId: worktree.repoId,
    worktreeId: worktree.id,
    // A repo missing from `state.repos` (removed, or filtered to another host)
    // has no display name; its id is shown rather than an empty label.
    repoName: boundedLabel(repo?.displayName ?? worktree.repoId),
    worktreeName: boundedLabel(worktree.displayName),
    // `metadata.workspaceKind` is the same projection the active rows get, so a
    // folder workspace hides a directory path here for the same reason it does
    // there (README §7.4.2: a workspace identity names a branch, or nothing).
    ...(branchName ? { branchName } : {}),
    ...metadata,
    isArchived: worktree.isArchived,
    lastActivityAt: worktree.lastActivityAt
  }
}
