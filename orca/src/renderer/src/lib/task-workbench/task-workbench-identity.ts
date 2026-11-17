import { areTaskProviderIdentitiesEqual } from '../../../../shared/task-provider-identity'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import { taskWorkbenchTaskKey } from './task-workbench-selector-types'
import type {
  IdentityInput,
  IdentityResolution,
  IdentityWorktree,
  TaskWorkbenchIdentity
} from './task-workbench-selector-types'

/**
 * The P1b identity selector (README §3.4 "任务身份：唯一空白", §6.4 selector 合同,
 * §7.6). One task -> one deterministic `taskKey`, resolved from the two shapes
 * the view already declares: the tracker six-dimension identity, or the
 * primary worktree when the task has no tracker.
 *
 * Why a precedence chain instead of "pick the best": the three sources disagree
 * in authority, not in quality. A caller holding the task itself knows the
 * tracker identity even when no worktree is linked yet; a worktree's
 * `linkedTaskSourceContext` is provenance recorded at creation; the worktree
 * itself is only the local-task fallback. Applying the chain in that order
 * means the same renderer input always yields the same key — and therefore the
 * same grouping — across reloads and entry points.
 *
 * Pure on purpose: no React, no store, no RPC, no clock, so the hook that reads
 * `@/store` is the only place that assembles this input.
 */
export function resolveTaskIdentity(input: IdentityInput): IdentityResolution | null {
  // 1. The task's own tracker identity, but only when a provider identity came
  //    with it. `provider` / `projectId` alone cannot produce a `taskKey`, and
  //    guessing one from them would invent an identity the store never held.
  const taskSourceProvider = input.taskSourceContext?.providerIdentity ?? null
  if (taskSourceProvider) {
    return resolveTrackerIdentity(taskSourceProvider, 'task-source-context', input.worktrees)
  }

  // 2. Provenance recorded on a live worktree. Archived worktrees are skipped
  //    here so a stale linked context cannot name a task the user has removed.
  const linkedWorktree = input.worktrees.find(
    (worktree) => !worktree.isArchived && getLinkedProviderIdentity(worktree) !== null
  )
  const linkedProvider = linkedWorktree ? getLinkedProviderIdentity(linkedWorktree) : null
  if (linkedProvider) {
    return resolveTrackerIdentity(linkedProvider, 'worktree', input.worktrees)
  }

  // 3. No tracker anywhere: the first live worktree *is* the task (README §3.4
  //    plan B). Input order is the caller's display order, never re-sorted here.
  const primaryWorktree = input.worktrees.find((worktree) => !worktree.isArchived)
  if (!primaryWorktree) {
    return null
  }
  const workspaceIdentity: TaskWorkbenchIdentity = {
    kind: 'workspace',
    primaryWorktreeId: primaryWorktree.worktreeId
  }
  return {
    identity: workspaceIdentity,
    taskKey: taskWorkbenchTaskKey(workspaceIdentity),
    source: 'workspace-fallback',
    matchedWorktreeIds: [primaryWorktree.worktreeId]
  }
}

type TrackerSource = Extract<IdentityResolution['source'], 'task-source-context' | 'worktree'>

function resolveTrackerIdentity(
  provider: TaskProviderIdentity,
  source: TrackerSource,
  worktrees: readonly IdentityWorktree[]
): IdentityResolution {
  const identity: TaskWorkbenchIdentity = { kind: 'tracker', provider }
  return {
    identity,
    // The key always comes from the frozen contract helper, so a worktree row
    // and a detail page normalize the same identity into the same grouping key.
    taskKey: taskWorkbenchTaskKey(identity),
    source,
    // Equality goes through `areTaskProviderIdentitiesEqual` (GitHub host
    // normalization included), never a stringified comparison: two identities
    // that differ only in an absent-vs-null optional field are still equal.
    matchedWorktreeIds: worktrees
      .filter(
        (worktree) =>
          !worktree.isArchived &&
          areTaskProviderIdentitiesEqual(getLinkedProviderIdentity(worktree), provider)
      )
      .map((worktree) => worktree.worktreeId)
  }
}

function getLinkedProviderIdentity(worktree: IdentityWorktree): TaskProviderIdentity | null {
  return worktree.linkedTaskSourceContext?.providerIdentity ?? null
}
