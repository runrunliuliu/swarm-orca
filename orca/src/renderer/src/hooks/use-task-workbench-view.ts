import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isAgentJournalTurnOutcome } from '../../../shared/agent-turn-outcome'
import type { DashboardCard, DashboardWorkspace } from '../../../shared/dashboard-snapshot'
import { LOCAL_EXECUTION_HOST_ID, getWorktreeExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { Worktree } from '../../../shared/worktree/types'
import { boundedLabel } from '@/components/dashboard/dashboard-card-labels'
import { readDashboardClientHost } from '@/components/dashboard/dashboard-client-host'
import { dashboardCardMapWorkspaceMetadata } from '@/components/dashboard/dashboard-snapshot-workspaces'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import type { TaskWorkbenchView } from '@/components/task-workbench/task-workbench-view'
import { resolveTaskIdentity } from '@/lib/task-workbench/task-workbench-identity'
import { joinTaskWorkbench } from '@/lib/task-workbench/task-workbench-join'
import {
  worktreeUsageKey,
  type JoinAgentInput,
  type JoinWorktree,
  type UsageBreakdownRow,
  type UsageSelectorInput
} from '@/lib/task-workbench/task-workbench-selector-types'
import { selectTaskWorkbenchUsage } from '@/lib/task-workbench/task-workbench-usage'

/**
 * The store-reading half of the P1b workbench (task source item 4): the `Orca`
 * tab hands the page's identity here and receives the `TaskWorkbenchView` the
 * P1a shell already renders. The shell keeps its `view` prop and stays
 * store-free; this is the one module allowed to read `@/store` (contract
 * "Directory convention"; README §6.4 selector contract).
 *
 * Why the assembly lives here and not in the selectors: identity, join and usage
 * are frozen pure functions, and re-deciding any of their rules below would give
 * the workbench a second opinion on buckets, counts or attribution
 * (development-plan §2). This module only *feeds* them — store rows in, their
 * input shapes out, in store order.
 *
 * Two named gaps, deliberately not guessed (M1 / M3 scope, not P1b):
 * - `attribution: null` — the `ambiguous_session` decision lives in
 *   `resolveAutomationRunUsage` (main process), which a renderer hook cannot
 *   call. The session-level ambiguity verdict is M1's; the hook never claims
 *   `none` on its own.
 * - `deliveryByWorktree: undefined` — per-workspace delivery evidence
 *   aggregation (commits / checks / review) is M3. The join returns no
 *   `delivery`, and the Delivery section degrades to its notice instead of
 *   reporting a zero.
 */

export type TaskWorkbenchViewArgs = {
  /** Repo id of the detail page; null disables the hook. */
  repoId: string | null
  /** Issue or PR number of the detail page. */
  number: number
  itemType: 'issue' | 'pr'
  /** Page title; the view has no way to derive it. */
  title: string
  /** Tracker state + url, when the page knows it. */
  tracker?: { state: 'open' | 'closed'; url: string }
  /** The detail page's own task source context, when it has one. */
  taskSourceContext?: TaskSourceContext | null
}

/** One retained session's own total, ready for `UsageSelectorInput.agents`. */
type AgentUsageEntry = { paneKey: string; session: { tokens: number } }

export function useTaskWorkbenchView(args: TaskWorkbenchViewArgs): TaskWorkbenchView | null {
  const { repoId, number, itemType, title, tracker, taskSourceContext } = args
  const worktrees = useAppStore((state) =>
    repoId === null ? undefined : state.worktreesByRepo[repoId]
  )
  const repo = useAppStore((state) =>
    repoId === null ? undefined : state.repos.find((candidate) => candidate.id === repoId)
  )
  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)
  // The four `*UsageProjectBreakdown` keys are `worktree:<worktreeId>`
  // (README §7.6); the four `*UsageRecentSessions` arrays are the only source of
  // a per-agent number, because a worktree rollup cannot be split per agent.
  const claudeScanState = useAppStore((state) => state.claudeUsageScanState)
  const codexScanState = useAppStore((state) => state.codexUsageScanState)
  const openCodeScanState = useAppStore((state) => state.openCodeUsageScanState)
  const museScanState = useAppStore((state) => state.museUsageScanState)
  const claudeBreakdown = useAppStore((state) => state.claudeUsageProjectBreakdown)
  const codexBreakdown = useAppStore((state) => state.codexUsageProjectBreakdown)
  const openCodeBreakdown = useAppStore((state) => state.openCodeUsageProjectBreakdown)
  const museBreakdown = useAppStore((state) => state.museUsageProjectBreakdown)
  const claudeSessions = useAppStore((state) => state.claudeUsageRecentSessions)
  const codexSessions = useAppStore((state) => state.codexUsageRecentSessions)
  const openCodeSessions = useAppStore((state) => state.openCodeUsageRecentSessions)
  const museSessions = useAppStore((state) => state.museUsageRecentSessions)
  // All four null or all false is `disabled`; one enabled provider is enough for
  // a per-provider figure to be real (README §7.5).
  const usageEnabled =
    claudeScanState?.enabled === true ||
    codexScanState?.enabled === true ||
    openCodeScanState?.enabled === true ||
    museScanState?.enabled === true

  // The in-window dashboard projection, built by the same hook the agent
  // dashboard popover uses: one card per agent, one workspace per active
  // worktree. Reusing it is the point (development-plan §2) — a second row
  // pipeline would give the workbench its own bucket and label rules, and a
  // second copy of the `DashboardSnapshotState` key list would drift the moment
  // a slice is added upstream.
  const snapshot = useLiveDashboardSnapshot()

  const resolution = useMemo(() => {
    // Provenance the identity selector reads; archived rows are handed over as
    // such so it can refuse to name a task by a worktree the user put away.
    const identityWorktrees = (worktrees ?? []).map((worktree) => ({
      worktreeId: worktree.id,
      isArchived: worktree.isArchived,
      linkedTaskSourceContext: worktree.linkedTaskSourceContext
    }))
    return resolveTaskIdentity({
      taskSourceContext: taskSourceContext ?? null,
      worktrees: identityWorktrees
    })
  }, [worktrees, taskSourceContext])

  return useMemo<TaskWorkbenchView | null>(() => {
    // No identity means there is nothing to name the tab after: that is the one
    // case the identity selector returns null for, and `identity` is a required
    // field of the view, so the page keeps its own empty notice instead of a
    // synthesised identity. A tracker-backed task with ZERO workspaces is not
    // this case — it resolves, and gets `workspaces: []` plus the unavailable
    // spend (the F2a shape the panel renders itself).
    if (!resolution) {
      return null
    }
    // Matched worktrees are a 0..N question that includes archived rows, so the
    // single-row `findGithubPrWorkspaceAttachment` /
    // `findGithubIssueWorkspaceAttachment` helpers cannot answer it: each
    // returns at most one *non-archived* match
    // (`github-work-item-workspace-attachment.ts:12-33`). README §7.6 names the
    // plural variant as the upgrade point. Store order, visited once each, so
    // the union is de-duplicated by construction.
    const matched = new Set(resolution.matchedWorktreeIds)
    const taskWorktrees = (worktrees ?? []).filter((worktree) => {
      if (matched.has(worktree.id)) {
        return true
      }
      const linked = itemType === 'pr' ? worktree.linkedPR : worktree.linkedIssue
      return worktree.repoId === repoId && linked === number
    })
    // Active workspaces reuse the value the snapshot already projected. Archived
    // ones are dropped by `collectActiveDashboardWorkspaces` by construction and
    // are rebuilt by the same two helpers below.
    const projected = new Map<string, DashboardWorkspace>(
      (snapshot.workspaces ?? []).map((workspace) => [workspace.worktreeId, workspace])
    )
    const joinedWorktrees = taskWorktrees.map((worktree) => {
      const workspace = projected.get(worktree.id)
      // The store's own activity signal (the sidebar's "Recent" key): newest
      // wins the default workspace, and 0 can only lose that comparison.
      return workspace
        ? { ...workspace, isArchived: worktree.isArchived, lastActivityAt: worktree.lastActivityAt }
        : projectMissingWorkspace(repo, worktree)
    })
    const activeWorktrees = joinedWorktrees.filter((workspace) => !workspace.isArchived)
    const activeIds = activeWorktrees.map((workspace) => workspace.worktreeId)
    const cards = new Map<string, DashboardCard[]>()
    for (const card of snapshot.cards) {
      const existing = cards.get(card.worktreeId)
      if (existing) {
        existing.push(card)
      } else {
        cards.set(card.worktreeId, [card])
      }
    }
    // Per-agent attribution from retained sessions only. A miss — or a
    // `sessionId` two providers both claim — stays absent, and the usage
    // selector turns absence into `unattributed`, never into a fabricated share
    // (README §7.5).
    const sessionTotals = new Map<string, number | null>()
    const record = (sessionId: string, tokens: number): void => {
      sessionTotals.set(sessionId, sessionTotals.has(sessionId) ? null : tokens)
    }
    for (const session of claudeSessions) {
      record(session.sessionId, claudeSessionTokens(session))
    }
    for (const session of codexSessions) {
      record(session.sessionId, session.totalTokens)
    }
    for (const session of openCodeSessions) {
      record(session.sessionId, session.totalTokens)
    }
    for (const session of museSessions) {
      record(session.sessionId, session.totalTokens)
    }
    const agentUsage: AgentUsageEntry[] = []
    for (const worktreeId of activeIds) {
      for (const card of cards.get(worktreeId) ?? []) {
        const sessionId = agentStatusByPaneKey[card.paneKey]?.providerSession?.id
        const tokens = sessionId ? sessionTotals.get(sessionId) : null
        if (typeof tokens === 'number') {
          agentUsage.push({ paneKey: card.paneKey, session: { tokens } })
        }
      }
    }
    const usage = selectTaskWorkbenchUsage({
      worktreeIds: activeIds,
      enabled: usageEnabled,
      // README §7.5: usage is unavailable on a non-local host, and the host is
      // the resolved host id — never an assumption that this renderer is local.
      remote: activeWorktrees.some(
        (workspace) => workspace.executionHostId !== LOCAL_EXECUTION_HOST_ID
      ),
      providers: selectProviders(
        activeIds,
        claudeBreakdown,
        codexBreakdown,
        openCodeBreakdown,
        museBreakdown
      ),
      // Named gap: M1 owns the session-level ambiguity decision.
      attribution: null,
      agents: agentUsage
    })
    // Per-row facts a projected card cannot carry. `outcome` goes through
    // `isAgentJournalTurnOutcome` instead of a cast, so an absent or unexpected
    // verdict stays unknown and a plain Stop is never read as success.
    const agentsByWorktree: Record<string, JoinAgentInput[]> = {}
    for (const worktreeId of activeIds) {
      agentsByWorktree[worktreeId] = (cards.get(worktreeId) ?? []).map((card) => {
        const entry = agentStatusByPaneKey[card.paneKey]
        const verdict = entry?.mainAgent?.outcome
        const tokens = usage.agentTokens[card.paneKey]
        return {
          card,
          ...(isAgentJournalTurnOutcome(verdict) ? { outcome: verdict } : {}),
          ...(entry?.sessionBoundary === true ? { sessionBoundary: true } : {}),
          ...(tokens ? { tokens } : {})
        }
      })
    }
    const join = joinTaskWorkbench({
      identity: resolution,
      worktrees: joinedWorktrees,
      agentsByWorktree,
      // Named gap: M3 owns per-workspace delivery evidence.
      deliveryByWorktree: undefined,
      // Named gap: an explicit primary needs persistence (M2b), so the join
      // reports `recent-activity` / `none` and never claims a user choice.
      primaryWorktreeId: undefined
    })
    return {
      identity: resolution.identity,
      title,
      ...(tracker ? { tracker } : {}),
      defaultWorkspace: join.defaultWorkspace,
      agents: join.agents,
      workspaces: join.workspaces,
      spend: usage.spend,
      delivery: join.delivery
    }
  }, [
    resolution,
    worktrees,
    itemType,
    repoId,
    number,
    repo,
    snapshot,
    agentStatusByPaneKey,
    usageEnabled,
    claudeBreakdown,
    codexBreakdown,
    openCodeBreakdown,
    museBreakdown,
    claudeSessions,
    codexSessions,
    openCodeSessions,
    museSessions,
    title,
    tracker
  ])
}

/** The workspace value for a row the snapshot does not carry — an archived
 *  worktree, or defensively an active one past `DASHBOARD_MAX_MAP_WORKSPACES`.
 *  The host fields come from the same two helpers the snapshot uses, so an
 *  archived remote workspace resolves to its real host instead of coming out
 *  local.
 *
 *  Deliberately not filled in for these rows: `workspaceStatus*`, `hasReview`,
 *  `review` (their source is the card-side context, which the snapshot only
 *  projects for active rows) and `hostLabel` (a module-private saved-host label
 *  lookup). The archived fold therefore shows repo · worktree, the archived and
 *  host-kind badges and nothing else — an addition for archived rows, not a
 *  regression against the snapshot the active rows get. `parentWorktreeId` is
 *  out for the same reason the dashboard needs a widened row type to read it:
 *  the `Worktree` type does not declare it. */
function projectMissingWorkspace(repo: Repo | undefined, worktree: Worktree): JoinWorktree {
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
  return {
    repoId: worktree.repoId,
    worktreeId: worktree.id,
    // A repo missing from `state.repos` (removed, or filtered to another host)
    // has no display name; its id is shown rather than an empty label.
    repoName: boundedLabel(repo?.displayName ?? worktree.repoId),
    worktreeName: boundedLabel(worktree.displayName),
    ...metadata,
    isArchived: worktree.isArchived,
    lastActivityAt: worktree.lastActivityAt
  }
}

/** One provider's rows normalized to `UsageBreakdownRow`, keeping only keys that
 *  are one of the active `worktree:<id>` values — an exact match, never a
 *  substring and never a `repo:` sibling (README §7.6). Claude publishes four
 *  token fields and no total; the other three expose `totalTokens`; Muse
 *  publishes no cost at all, which stays `null` (unpriced), never `$0`. */
function selectProviders(
  activeWorktreeIds: readonly string[],
  claude: AppState['claudeUsageProjectBreakdown'],
  codex: AppState['codexUsageProjectBreakdown'],
  opencode: AppState['openCodeUsageProjectBreakdown'],
  muse: AppState['museUsageProjectBreakdown']
): UsageSelectorInput['providers'] {
  const keys = new Set(activeWorktreeIds.map((worktreeId) => worktreeUsageKey(worktreeId)))
  const select = <T extends { key: string; label: string }>(
    rows: readonly T[],
    tokensOf: (row: T) => number,
    costOf: (row: T) => number | null
  ): UsageBreakdownRow[] =>
    rows
      .filter((row) => keys.has(row.key))
      .map((row) => ({
        key: row.key,
        label: row.label,
        tokens: tokensOf(row),
        costUsd: costOf(row)
      }))
  return [
    {
      provider: 'claude',
      rows: select(claude, claudeBreakdownTokens, (row) => row.estimatedCostUsd)
    },
    {
      provider: 'codex',
      rows: select(
        codex,
        (row) => row.totalTokens,
        (row) => row.estimatedCostUsd
      )
    },
    {
      provider: 'opencode',
      rows: select(
        opencode,
        (row) => row.totalTokens,
        (row) => row.estimatedCostUsd
      )
    },
    {
      provider: 'muse',
      rows: select(
        muse,
        (row) => row.totalTokens,
        () => null
      )
    }
  ]
}

function claudeBreakdownTokens(row: AppState['claudeUsageProjectBreakdown'][number]): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
}

function claudeSessionTokens(row: AppState['claudeUsageRecentSessions'][number]): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
}
