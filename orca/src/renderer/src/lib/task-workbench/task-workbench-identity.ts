import { areTaskProviderIdentitiesEqual } from '../../../../shared/task-provider-identity'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import { taskWorkbenchTaskKey } from './task-workbench-selector-types'
import type {
  IdentityInput,
  IdentityResolution,
  IdentityWorktree,
  TaskWorkbenchIdentity,
  TaskWorkbenchItem
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
 * Why the item is a separate input and not part of `TaskProviderIdentity`
 * (issue #38): the provider identity is the selector's existing repo-scoped
 * cache seam (`taskProviderIdentityCachePart`), and a worktree stores it as
 * provenance. The *item* — `issue:412`, `pr:9` — is what the caller is looking
 * at, and it is what makes two issues of one repo two tasks rather than one.
 *
 * This function names a task. It deliberately does not return the task's
 * worktrees: an identity is not a collection, and reading the repo-scoped key
 * as a workspace set is exactly the bug in issue #38. Membership is asked per
 * worktree through `worktreeLinksTaskItem` / `selectTaskItemWorktrees` below.
 *
 * Pure on purpose: no React, no store, no RPC, no clock, so the hook that reads
 * `@/store` is the only place that assembles this input.
 */
export function resolveTaskIdentity(input: IdentityInput): IdentityResolution | null {
  const item = normalizeTaskItem(input.item)

  // 1. The task's own tracker identity, but only when a provider identity came
  //    with it. `provider` / `projectId` alone cannot produce a `taskKey`, and
  //    guessing one from them would invent an identity the store never held.
  const taskSourceProvider = input.taskSourceContext?.providerIdentity ?? null
  if (taskSourceProvider) {
    return resolveTrackerIdentity(taskSourceProvider, 'task-source-context', item)
  }

  // 2. Provenance recorded on a worktree. A live worktree wins; an archived one
  //    is the next best proof, because a worktree the user put away still says
  //    which task it was created from and issue #31 needs that identity to keep
  //    stating the task's history. A deleted worktree has no row left to ask.
  //    When the caller named the item, only a worktree that links *that* item may
  //    speak for it: another branch's provenance names another task.
  const provenanceCandidates = item
    ? input.worktrees.filter((worktree) => worktreeLinksTaskItem(worktree, item, null))
    : input.worktrees
  const linkedWorktree =
    provenanceCandidates.find(
      (worktree) => !worktree.isArchived && getLinkedProviderIdentity(worktree)
    ) ?? provenanceCandidates.find((worktree) => getLinkedProviderIdentity(worktree))
  const linkedProvider = linkedWorktree ? getLinkedProviderIdentity(linkedWorktree) : null
  if (linkedProvider) {
    return resolveTrackerIdentity(
      linkedProvider,
      linkedWorktree?.isArchived === true ? 'archived-worktree' : 'worktree',
      item
    )
  }

  // 3. No tracker anywhere: the first live worktree *is* the task (README §3.4
  //    plan B); with none live, the first archived one answers instead so a
  //    closed local task still gets a workspace identity. Input order is the
  //    caller's display order, never re-sorted here.
  //
  //    With an item, the candidates are that item's worktrees only, and "none"
  //    stays none: falling back to the repo's first live worktree is what made
  //    an issue that never ran anything show another issue's branch (issue #38).
  const fallbackCandidates = item
    ? input.worktrees.filter((worktree) => worktreeLinksTaskItem(worktree, item, null))
    : input.worktrees
  const primaryWorktree =
    fallbackCandidates.find((worktree) => !worktree.isArchived) ??
    fallbackCandidates.find((worktree) => worktree.isArchived)
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
    source: primaryWorktree.isArchived ? 'archived-worktree' : 'workspace-fallback'
  }
}

type TrackerSource = Extract<
  IdentityResolution['source'],
  'task-source-context' | 'worktree' | 'archived-worktree'
>

function resolveTrackerIdentity(
  provider: TaskProviderIdentity,
  source: TrackerSource,
  item: TaskWorkbenchItem | null
): IdentityResolution {
  const identity: TaskWorkbenchIdentity = { kind: 'tracker', provider, item }
  return {
    identity,
    // The key always comes from the frozen contract helper, so a worktree row
    // and a detail page normalize the same identity into the same grouping key.
    taskKey: taskWorkbenchTaskKey(identity),
    source
  }
}

/**
 * One workspace row -> whether it belongs to this task item (issue #38).
 *
 * Repo scope is the caller's: the tab and the list already hand over one repo's
 * worktrees (`repoId` + the number columns was the pair the sidebar used to
 * reserve a workspace). What this adds is the *item* scope — `linkedIssue` /
 * `linkedPR`, the columns GitHub rows carry, or `linkedWorkItem`, the
 * provider-neutral record — plus provider/host agreement when the worktree
 * recorded provenance, so a GHES branch cannot answer a github.com item.
 *
 * Why membership is not the identity's: `taskKey` is a name, one per task. Until
 * issue #38 its repo-scoped form was being read as the task's workspace set,
 * which put every branch of the repo in every item's tab. Asked per worktree,
 * zero matches is a real answer.
 *
 * Archived rows match too: issue #31 needs them to state a closed task's
 * history, and the caller decides which of them may contribute a row.
 */
export function worktreeLinksTaskItem(
  worktree: IdentityWorktree,
  item: TaskWorkbenchItem,
  provider: TaskProviderIdentity | null
): boolean {
  return (
    (matchesLinkedWorkItem(worktree, item, provider) || matchesNumberColumn(worktree, item)) &&
    providerIdentityAgreesWithTask(worktree, provider)
  )
}

/**
 * The task's worktrees, in input order. One rule for every caller — the detail
 * page tab and the list row badge — so the collection cannot drift from the
 * identity, and so nobody re-derives "which workspaces are this item's".
 */
export function selectTaskItemWorktrees<T extends IdentityWorktree>(
  worktrees: readonly T[],
  item: TaskWorkbenchItem,
  provider: TaskProviderIdentity | null
): T[] {
  return worktrees.filter((worktree) => worktreeLinksTaskItem(worktree, item, provider))
}

/** The provider-neutral link record wins when it exists, because it names the
 *  provider and the item type as well as the number. A stale record is not a
 *  worry: meta edits that re-point a workspace clear it. PR and MR are the same
 *  task from this side, and `issue` never matches a PR row. */
function matchesLinkedWorkItem(
  worktree: IdentityWorktree,
  item: TaskWorkbenchItem,
  provider: TaskProviderIdentity | null
): boolean {
  const linked = worktree.linkedWorkItem ?? null
  if (!linked) {
    return false
  }
  const typeMatches =
    item.type === 'issue' ? linked.type === 'issue' : linked.type === 'pr' || linked.type === 'mr'
  return (
    linked.number === item.number &&
    typeMatches &&
    (provider === null || linked.provider === provider.provider)
  )
}

/** The number columns, for workspaces that predate `linkedWorkItem` (and for
 *  the rows that only ever carried these). GitHub numbers issues and PRs
 *  separately, so the page's item type decides which column counts. */
function matchesNumberColumn(worktree: IdentityWorktree, item: TaskWorkbenchItem): boolean {
  return item.type === 'issue'
    ? worktree.linkedIssue === item.number
    : worktree.linkedPR === item.number
}

/** A worktree with no recorded provenance cannot contradict the task, so it is
 *  accepted; one that recorded a repo/host must agree with it. */
function providerIdentityAgreesWithTask(
  worktree: IdentityWorktree,
  provider: TaskProviderIdentity | null
): boolean {
  const linked = getLinkedProviderIdentity(worktree)
  if (!provider || !linked) {
    return true
  }
  return areTaskProviderIdentitiesEqual(linked, provider)
}

function normalizeTaskItem(item: TaskWorkbenchItem | null | undefined): TaskWorkbenchItem | null {
  if (!item) {
    return null
  }
  if (item.type !== 'issue' && item.type !== 'pr') {
    return null
  }
  // Why: 0 is not a tracker number but "not known" (Jira/Linear rows carry it
  // alongside their own identifier), and matching it would make every such
  // workspace the same item.
  if (!Number.isFinite(item.number) || item.number <= 0) {
    return null
  }
  return { type: item.type, number: item.number }
}

function getLinkedProviderIdentity(worktree: IdentityWorktree): TaskProviderIdentity | null {
  return worktree.linkedTaskSourceContext?.providerIdentity ?? null
}
