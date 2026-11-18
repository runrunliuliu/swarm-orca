import type { AgentDotState } from '@/components/AgentStateDot'
import { taskWorkbenchOverlayDotState } from '@/components/task-workbench/task-workbench-agent-row-dot'
import type { AgentOutcome } from '@/components/task-workbench/task-workbench-view'
import type { DashboardCardDotState } from '../../../../shared/dashboard-snapshot'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { resolveTaskIdentity } from './task-workbench-identity'
import type { IdentityWorktree } from './task-workbench-selector-types'

/**
 * The P3 thin-slice row activity selector (issue #27): one tracker list row ->
 * the Orca-side mark that sits beside its provider state. Pure on purpose — no
 * React, no store, no clock, no RPC — so the list hook only assembles rows and
 * worktrees, and every rule below is asserted directly.
 *
 * Why the provider state is not the answer: `Open` / `Closed` / `Merged` is the
 * tracker's own fact, and creating a workspace deliberately never writes back
 * to it (README §6.1, §7.2). Orca activity is therefore derived on every
 * render from the worktrees and agent rows the store already holds — never
 * cached and never persisted, so resuming an agent leaves `Delivered` without
 * an invalidation step.
 *
 * Why the row, not the task, decides which worktrees count: `resolveTaskIdentity`
 * names a GitHub task by owner/repo (`taskProviderIdentityCachePart` carries the
 * repository, not the issue number, `task-workbench-selector-types.ts:118-126`),
 * so one repo's issues would share a key and one row's agents would mark every
 * row. This selector therefore keeps the row-scoped lookup the list already
 * uses — `repoId` plus `linkedIssue` / `linkedPR`, the same pair
 * `findGithubWorkItemWorkspaceAttachment` reads — and reuses the identity
 * selector only for the task key it records. The map it returns is keyed by the
 * caller's row key, which is why the identity key can stay repo-scoped here.
 *
 * Why `Workspace` exists (README §7.2, decision recorded there with this
 * module): §7.2 defined "0 workspaces" and "has an agent", leaving "workspace
 * bound, no agent yet" blank. That is a real state — the user created the
 * workspace and may not have started an agent — so it gets a neutral gray mark.
 * It is never `Working` (nothing is running) and never `Delivered` (no agent
 * means no finished turn). 0 workspaces is not this state at all: there is
 * nothing Orca owns, so the row gets no mark and no placeholder.
 *
 * Rules, taken from README §7.2 / D12 rather than restated as new policy:
 * - only non-archived worktrees participate (`Needs you` > `Working` > `Delivered`);
 * - Needs you = a live attention row (`blocked` / `waiting`) or an F8 verdict
 *   (`failed` / `interrupted`), because a failed main agent is news even when a
 *   subagent still runs (`task-workbench-agent-row-dot.tsx:20-40`);
 * - Delivered = agent done: `sessionBoundary` never counts (a connect/resume/clear
 *   landing is not a finished turn), `failure` / `cancellation` never count, and
 *   an absent `outcome` still counts when the row reports `done`.
 */

/** What the row claims about Orca activity. `workspace` is the "bound, nothing
 *  running" state this module adds to README §7.2; the other three are that
 *  section's grouping order. */
export type TaskWorkbenchRowActivityKind = 'needs-you' | 'working' | 'delivered' | 'workspace'

/** One agent in a worktree, as the caller already projected it. The four F8
 *  states are the only ones a row badge can render (see the dot union below). */
export type TaskWorkbenchRowAgent = {
  /** The published card dot state, so `done` survives the dashboard's
   *  acknowledged-to-idle settle (`dashboardCardDisplayState`). */
  dotState: DashboardCardDotState
  outcome?: AgentOutcome
  sessionBoundary?: boolean
}

/** A worktree plus the two facts the row lookup needs. `IdentityWorktree`
 *  supplies id / archive flag / provenance for the identity selector. */
export type TaskWorkbenchRowWorktree = IdentityWorktree & {
  repoId: string
  linkedIssue?: number | null
  linkedPR?: number | null
  /** Agents in this worktree, already projected. Archived rows are ignored. */
  agents?: readonly TaskWorkbenchRowAgent[]
}

export type TaskWorkbenchRowInput = {
  /** The caller's unique row key (the list's own item key). */
  rowKey: string
  repoId: string
  itemType: 'issue' | 'pr'
  itemNumber: number
  /** The row's tracker context, when the page has one. Only the identity
   *  selector reads it, so an absent context falls back to a linked worktree. */
  taskSourceContext?: TaskSourceContext | null
}

export type TaskWorkbenchRowActivityInput = {
  /** The rows on the current page, in display order. */
  rows: readonly TaskWorkbenchRowInput[]
  /** Worktrees of every repo those rows come from, archived included. */
  worktrees: readonly TaskWorkbenchRowWorktree[]
}

type RowActivityBase = {
  /** Non-archived workspaces bound to this row (never 0: 0 rows are omitted). */
  workspaceCount: number
  /** Agents in those workspaces, any state. */
  agentCount: number
  /** The identity selector's task key for this row. Repo-scoped for GitHub
   *  today, which is why the map is keyed by the caller's row key instead. */
  taskKey: string
}

/** The four F8 marks an attention row may render — the vocabulary
 *  `task-workbench-agent-row-dot.tsx` already owns, pinned here to
 *  `AgentStateDot` so a typo cannot invent a glyph name. */
type NeedsYouDotState = Extract<AgentDotState, 'failed' | 'blocked' | 'waiting' | 'interrupted'>

/** The per-agent claim, before the row aggregates them. No `workspace`: that
 *  kind is the absence of any claim, not a claim an agent makes. */
type AgentClaim =
  | { kind: 'needs-you'; dotState: NeedsYouDotState }
  | { kind: 'working'; dotState: 'working' }
  | { kind: 'delivered'; dotState: 'done' }

/** A discriminated union so a badge cannot pair a claim with a dot the claim
 *  cannot produce: `workspace` is always the neutral gray dot, `delivered`
 *  always the check, and `needs-you` carries only the four F8 marks. */
export type TaskWorkbenchRowActivity =
  | (RowActivityBase & Extract<AgentClaim, { kind: 'needs-you' }>)
  | (RowActivityBase & Extract<AgentClaim, { kind: 'working' }>)
  | (RowActivityBase & Extract<AgentClaim, { kind: 'delivered' }>)
  | (RowActivityBase & { kind: 'workspace'; dotState: 'idle' })

/**
 * One page of rows -> the activity of each row that has any. A row with no
 * non-archived worktree is absent from the map, not mapped to an empty value:
 * the caller renders nothing for it and nothing has to branch on a placeholder.
 */
export function resolveTaskWorkbenchRowActivity(
  input: TaskWorkbenchRowActivityInput
): Map<string, TaskWorkbenchRowActivity> {
  const activity = new Map<string, TaskWorkbenchRowActivity>()

  for (const row of input.rows) {
    // The identity selector's contract is "every worktree the caller already
    // filtered to this task's repo/host" (`IdentityInput.worktrees`), so the
    // repo filter happens here and never inside it.
    const repoWorktrees = input.worktrees.filter((worktree) => worktree.repoId === row.repoId)
    const boundWorktrees = repoWorktrees.filter(
      (worktree) => !worktree.isArchived && linksRow(worktree, row)
    )
    if (boundWorktrees.length === 0) {
      continue
    }
    const agents = boundWorktrees.flatMap((worktree) => worktree.agents ?? [])
    // Non-null by construction: `boundWorktrees` holds a live worktree, which is
    // exactly the workspace-fallback branch of the identity selector. The check
    // stays because that guarantee lives in another module, and a key invented
    // here would be a second identity.
    const identity = resolveTaskIdentity({
      taskSourceContext: row.taskSourceContext ?? null,
      worktrees: repoWorktrees
    })
    if (!identity) {
      continue
    }
    const claim = aggregateClaims(agents)
    activity.set(row.rowKey, {
      ...(claim ?? { kind: 'workspace', dotState: 'idle' }),
      workspaceCount: boundWorktrees.length,
      agentCount: agents.length,
      taskKey: identity.taskKey
    })
  }

  return activity
}

/** Issue rows count issue links, PR rows count PR links: a worktree created
 *  from PR #7 must not speak for issue #7. */
function linksRow(worktree: TaskWorkbenchRowWorktree, row: TaskWorkbenchRowInput): boolean {
  return row.itemType === 'pr'
    ? worktree.linkedPR === row.itemNumber
    : worktree.linkedIssue === row.itemNumber
}

/**
 * README §7.2's union rule: `Needs you` > `Working` > `Delivered`, over every
 * live workspace of the row. `null` means no agent made any claim — every row
 * is idle, or there are no agents at all — which the caller reads as
 * `workspace`.
 */
function aggregateClaims(agents: readonly TaskWorkbenchRowAgent[]): AgentClaim | null {
  let needsYou: Extract<AgentClaim, { kind: 'needs-you' }> | null = null
  let working = false
  let delivered = false

  for (const agent of agents) {
    const claim = agentClaim(agent)
    if (!claim) {
      continue
    }
    if (claim.kind === 'needs-you') {
      // Deterministic glyph among attention rows: the worst claim wins, so the
      // mark does not depend on store order. Failure outranks everything (F8).
      if (!needsYou || needsYouRank(claim.dotState) < needsYouRank(needsYou.dotState)) {
        needsYou = claim
      }
      continue
    }
    if (claim.kind === 'working') {
      working = true
    } else {
      delivered = true
    }
  }

  if (needsYou) {
    return needsYou
  }
  if (working) {
    return { kind: 'working', dotState: 'working' }
  }
  if (delivered) {
    return { kind: 'delivered', dotState: 'done' }
  }
  return null
}

/** Lower is worse. Only used among `needs-you` marks, where all four are news. */
function needsYouRank(dotState: NeedsYouDotState): number {
  switch (dotState) {
    case 'failed':
      return 0
    case 'blocked':
      return 1
    case 'waiting':
      return 2
    case 'interrupted':
      return 3
  }
}

/**
 * One agent -> its claim, or `null` when it makes none. The F8 overlay comes
 * first so a failure is never read as ordinary work; `unverifiable` (a boundary
 * with no verdict) deliberately falls through to `null`, because a session
 * boundary says only that nothing is known.
 */
function agentClaim(agent: TaskWorkbenchRowAgent): AgentClaim | null {
  const overlay = taskWorkbenchOverlayDotState(agent)
  if (overlay === 'failed') {
    return { kind: 'needs-you', dotState: 'failed' }
  }
  if (agent.dotState === 'blocked') {
    return { kind: 'needs-you', dotState: 'blocked' }
  }
  if (agent.dotState === 'waiting') {
    return { kind: 'needs-you', dotState: 'waiting' }
  }
  if (overlay === 'interrupted') {
    return { kind: 'needs-you', dotState: 'interrupted' }
  }
  if (agent.dotState === 'working') {
    return { kind: 'working', dotState: 'working' }
  }
  if (isDelivered(agent)) {
    return { kind: 'delivered', dotState: 'done' }
  }
  // `idle` asserts that this agent is not on a turn, and `unverifiable`/no
  // evidence assert nothing at all — neither is a claim about the task.
  return null
}

/**
 * D12: `Delivered` is "the agent said this turn is done", not "the work passed
 * review". A session boundary is a connect/resume/clear landing and never a
 * finished turn; a failed or cancelled turn is not delivery; an absent outcome
 * (the provider never reported one) still counts when the row reports `done`,
 * because the lifecycle state is the evidence the store actually holds.
 */
function isDelivered(agent: TaskWorkbenchRowAgent): boolean {
  if (agent.sessionBoundary === true) {
    return false
  }
  if (agent.outcome === 'failure' || agent.outcome === 'cancellation') {
    return false
  }
  return agent.outcome === 'success' || (agent.outcome === undefined && agent.dotState === 'done')
}
