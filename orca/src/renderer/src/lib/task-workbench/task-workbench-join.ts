import { countRowBuckets } from '@/components/task-workbench/task-workbench-row-projection'
import type {
  AgentRowView,
  AgentTokenView,
  DeliveryEvidence,
  SpendReason,
  TaskWorkbenchHistory,
  TaskWorkbenchWorkspace
} from '@/components/task-workbench/task-workbench-view'
import type { JoinInput, JoinResult, JoinWorktree } from './task-workbench-selector-types'

/**
 * The P1b join selector (README §6.4 "selector 合同", §7.6): one task -> its
 * workspaces (0..N) -> agent rows -> bucket counts -> one delivery evidence
 * object, and the workspace the panel opens by default.
 *
 * Why it takes rows instead of building them: `buildWorktreeAgentRows` /
 * `selectWorktreeAgentRowsCached` already project an agent into a
 * `DashboardCard`, and the usage selector already decided what this row's
 * token view is. Re-deriving either here would give the workbench a second
 * opinion on bucket, attribution or cost (development-plan §2), so the input
 * carries the projected rows and this module only reassembles them.
 *
 * Why grouping is the union of *active* workspaces (README §6.4): a task is one
 * list item whose state is the union of its live workspaces, never its primary.
 * An archived workspace is something the user put away; letting it contribute a
 * `working` or `attention` row would resurrect a task they closed, so archived
 * worktrees contribute no active or attention rows and no delivery. Since issue
 * #31 they do contribute their history rows (marked `archivedWorkspace`), so a
 * closed task can still state what it ran instead of claiming it never started.
 *
 * Pure on purpose: no React, no store, no RPC, no clock. The only store-shaped
 * concern here is order, and order is the caller's (input order is display
 * order, and nothing is re-sorted for presentation).
 */
export function joinTaskWorkbench(input: JoinInput): JoinResult {
  const worktrees = input.worktrees
  const activeWorktrees = worktrees.filter((worktree) => !worktree.isArchived)
  const archivedWorktrees = worktrees.filter((worktree) => worktree.isArchived)

  // Active first, archived last (the "Show archived" fold reads the tail of
  // this list), each side keeping the caller's display order.
  const workspaces = [...activeWorktrees.map(toWorkspace), ...archivedWorktrees.map(toWorkspace)]
  const activeWorktreeIds = activeWorktrees.map((worktree) => worktree.worktreeId)
  const archivedWorktreeIds = archivedWorktrees.map((worktree) => worktree.worktreeId)

  // Why a label only when the task spans several live workspaces: with one
  // workspace the pill is noise, and the panel would repeat the header. With
  // more than one the row must say which workspace it belongs to. The label is
  // the branch the worktree identity now carries, falling back to the display
  // name the card already has — never a synthesised one and never the id. The
  // display name alone would usually repeat the task title (README §7.4.2).
  const showWorkspaceLabel = activeWorktrees.length + archivedWorktrees.length > 1
  const activeAgents = activeWorktrees.flatMap((worktree) =>
    (input.agentsByWorktree[worktree.worktreeId] ?? []).map((agent): AgentRowView => ({
      base: agent.card,
      // Unknown is not zero: an agent the usage selector could not attribute
      // keeps the reason, so the row prints "—" instead of a fabricated share.
      tokens: agent.tokens ?? UNATTRIBUTED_TOKENS,
      outcome: agent.outcome,
      sessionBoundary: agent.sessionBoundary,
      workspaceLabel: showWorkspaceLabel
        ? `${worktree.repoName} · ${worktree.branchName ?? worktree.worktreeName}`
        : undefined
    }))
  )
  // Archived rows last, so the History fold reads them after the live history.
  // The flag — not the card's bucket — decides the section: a retained row is
  // already `done`, but an archived worktree can still hold a stale working
  // status, and that must not resurrect `Working` on a task the user closed.
  const archivedAgents = archivedWorktrees.flatMap((worktree) =>
    (input.agentsByWorktree[worktree.worktreeId] ?? []).map((agent): AgentRowView => ({
      base: agent.card,
      tokens: agent.tokens ?? UNATTRIBUTED_TOKENS,
      outcome: agent.outcome,
      sessionBoundary: agent.sessionBoundary,
      workspaceLabel: showWorkspaceLabel
        ? `${worktree.repoName} · ${worktree.branchName ?? worktree.worktreeName}`
        : undefined,
      archivedWorkspace: true
    }))
  )
  const agents = [...activeAgents, ...archivedAgents]

  const defaultWorkspace = selectDefaultWorkspace(input.primaryWorktreeId, activeWorktrees)

  return {
    workspaces,
    activeWorktreeIds,
    archivedWorktreeIds,
    agents,
    // Same function the panel's layout uses, so a count can never disagree with
    // the section it counts. Archived rows land in `historyAgents` only.
    counts: countRowBuckets(agents),
    delivery: selectDelivery(
      input.deliveryByWorktree,
      defaultWorkspace.workspaceId,
      activeWorktreeIds
    ),
    defaultWorkspace,
    history: buildHistory(agents, worktrees)
  }
}

/** A row the usage selector could not attribute. A shared constant so every
 *  such row reads identically and none of them is a `0`. */
const UNATTRIBUTED_TOKENS: AgentTokenView = { kind: 'unavailable', reason: 'unattributed' }

/** `JoinWorktree` minus the join-only facts, plus the lifecycle flag the view
 *  carries. `archived` is omitted — not set to `false` — for a live workspace:
 *  an absent key means "not archived", and the fixtures build it the same way. */
function toWorkspace(worktree: JoinWorktree): TaskWorkbenchWorkspace {
  const { isArchived, lastActivityAt: _lastActivityAt, ...workspace } = worktree
  return isArchived ? { ...workspace, archived: true } : workspace
}

/**
 * The workspace the panel opens, and *why* the panel may say so. `source` is
 * explicit because projection has no persistence-backed primary yet (M2b):
 * "most recent activity" must never be presented as a user choice.
 *
 * `workspaceId: ''` is the "no workspace at all" value the shell already uses
 * for a task with zero worktrees (`task-workbench-fixtures-support.ts`
 * `tracked(title, null, …)`); it is a literal sentinel, never a worktree id, so
 * it cannot accidentally name an archived workspace.
 */
function selectDefaultWorkspace(
  primaryWorktreeId: string | undefined,
  activeWorktrees: readonly JoinWorktree[]
): JoinResult['defaultWorkspace'] {
  if (primaryWorktreeId) {
    // Explicit only when the named worktree is live: a primary the user archived
    // is not a choice the panel may keep honouring, and it must not be named.
    const explicit = activeWorktrees.find((worktree) => worktree.worktreeId === primaryWorktreeId)
    if (explicit) {
      return { workspaceId: explicit.worktreeId, source: 'explicit' }
    }
  }

  if (activeWorktrees.length === 0) {
    return { workspaceId: '', source: 'none' }
  }

  // Greatest `lastActivityAt` wins; a tie keeps the earlier one in input order,
  // because the comparison is strict and the caller's order is display order.
  // A missing timestamp is the *least* recent, not `0` (epoch would beat a real
  // clock reading and would silently claim "very old" instead of "unknown").
  let mostRecent = activeWorktrees[0]
  for (const worktree of activeWorktrees) {
    if (activityOf(worktree) > activityOf(mostRecent)) {
      mostRecent = worktree
    }
  }
  return { workspaceId: mostRecent.worktreeId, source: 'recent-activity' }
}

function activityOf(worktree: JoinWorktree): number {
  return worktree.lastActivityAt ?? Number.NEGATIVE_INFINITY
}

/**
 * The facts a closed task can still state (issue #31). Every absence stays an
 * absence: a token figure is the sum only when every row's figure is known, and
 * the wall clock is `measured` only when every row has both edges, so a task
 * with one agent still running reports `partial` instead of "now".
 *
 * The join can prove the archived form and nothing more. A deleted workspace has
 * already lost the rows this function would read, so `trace: 'deleted'` is set by
 * whoever holds that record (today: a rendered fixture; the persisted probe is
 * the S2 slice of #31).
 */
function buildHistory(
  agents: readonly AgentRowView[],
  worktrees: readonly JoinWorktree[]
): TaskWorkbenchHistory {
  const archived = worktrees.filter((worktree) => worktree.isArchived)

  let startedAt = Number.POSITIVE_INFINITY
  let endedAt = Number.NEGATIVE_INFINITY
  let everyStart = true
  let everyEnd = true
  let tokenTotal = 0
  let tokenAbsence: SpendReason | null = null

  for (const agent of agents) {
    if (agent.base.startedAt > 0) {
      startedAt = Math.min(startedAt, agent.base.startedAt)
    } else {
      everyStart = false
    }
    if (typeof agent.base.finishedAt === 'number') {
      endedAt = Math.max(endedAt, agent.base.finishedAt)
    } else {
      everyEnd = false
    }
    if (agent.tokens.kind === 'unavailable') {
      tokenAbsence ??= agent.tokens.reason
    } else {
      tokenTotal += agent.tokens.tokens
    }
  }

  const hasStart = startedAt !== Number.POSITIVE_INFINITY
  const hasEnd = endedAt !== Number.NEGATIVE_INFINITY
  const wall: TaskWorkbenchHistory['wall'] =
    agents.length === 0
      ? { kind: 'unknown' }
      : everyStart && everyEnd
        ? { kind: 'measured', startedAt, endedAt }
        : {
            kind: 'partial',
            ...(hasStart ? { startedAt } : {}),
            ...(hasEnd ? { endedAt } : {})
          }

  let lastActivityAt: number | undefined
  for (const worktree of worktrees) {
    if (worktree.lastActivityAt === undefined) {
      continue
    }
    lastActivityAt = Math.max(lastActivityAt ?? Number.NEGATIVE_INFINITY, worktree.lastActivityAt)
  }
  if (hasEnd) {
    lastActivityAt = Math.max(lastActivityAt ?? Number.NEGATIVE_INFINITY, endedAt)
  }

  return {
    // Zero rows is unknown, not zero agents: the record can outlive its rows.
    agents: agents.length === 0 ? null : agents.length,
    wall,
    tokens:
      agents.length === 0
        ? { kind: 'unavailable', reason: 'no_matching_session' }
        : tokenAbsence
          ? { kind: 'unavailable', reason: tokenAbsence }
          : { kind: 'available', tokens: tokenTotal },
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    archivedWorkspaces: archived.length,
    deletedWorkspaces: 0,
    // The join only sees what the store can show; a settled figure comes from the
    // persisted record (`mergeTaskRecordHistory`).
    tokensSource: 'live',
    workspaces: [],
    sessions: [],
    trace: archived.length > 0 ? 'archived' : 'none',
    runs: agents.map((agent) => ({
      key: agent.base.paneKey,
      title: agent.base.conversationName ?? agent.base.task ?? agent.base.worktreeName,
      ...(agent.base.agentType ? { agentType: agent.base.agentType } : {}),
      ...(agent.base.startedAt > 0 ? { startedAt: agent.base.startedAt } : {}),
      ...(typeof agent.base.finishedAt === 'number' ? { endedAt: agent.base.finishedAt } : {}),
      ...(agent.outcome ? { outcome: agent.outcome } : {})
    }))
  }
}

/**
 * One evidence object, never a merge: `commits`, `checks` and `pullRequest` are
 * per-workspace facts, and adding two workspaces' commit counts would report
 * delivery work that does not exist (README §7.5 "假 0" is the same rule read
 * the other way). Precedence:
 *
 * 1. the default workspace, when it has evidence — the panel already points at
 *    it, so its delivery is what the user is looking at;
 * 2. otherwise the first *active* workspace in display order with evidence;
 * 3. otherwise nothing, and the Delivery section degrades to its notice.
 *
 * Archived worktrees are never consulted: their evidence is what the user put
 * away, and a single archived PR would otherwise read as the task's delivery.
 */
function selectDelivery(
  deliveryByWorktree: JoinInput['deliveryByWorktree'],
  defaultWorkspaceId: string,
  activeWorktreeIds: readonly string[]
): DeliveryEvidence | undefined {
  if (!deliveryByWorktree) {
    return undefined
  }
  // Why the empty check: `''` is the "no workspace" sentinel, not a lookup key.
  if (defaultWorkspaceId !== '') {
    const defaultEvidence = deliveryByWorktree[defaultWorkspaceId]
    if (defaultEvidence) {
      return defaultEvidence
    }
  }
  for (const worktreeId of activeWorktreeIds) {
    const evidence = deliveryByWorktree[worktreeId]
    if (evidence) {
      return evidence
    }
  }
  return undefined
}
