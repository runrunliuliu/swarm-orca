import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { isAgentJournalTurnOutcome } from '../../../shared/agent-turn-outcome'
import type { DashboardCard, DashboardWorkspace } from '../../../shared/dashboard-snapshot'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import { projectMissingWorkspace } from '@/components/dashboard/project-missing-workspace'
import type { TaskWorkbenchView } from '@/components/task-workbench/task-workbench-view'
import { useTaskRecords } from './use-task-records'
import {
  resolveTaskIdentity,
  selectTaskItemWorktrees
} from '@/lib/task-workbench/task-workbench-identity'
import type { TaskWorkbenchItem } from '@/lib/task-workbench/task-workbench-selector-types'
import { workspaceBranchName } from '@/lib/task-workbench/task-workbench-workspace-branch'
import { deliveryEvidenceByWorktree } from '@/lib/task-workbench/task-workbench-delivery-evidence'
import { joinTaskWorkbench } from '@/lib/task-workbench/task-workbench-join'
import { mergeTaskRecordHistory } from '@/lib/task-workbench/task-workbench-history-merge'
import { archivedRowTokens } from '@/lib/task-workbench/task-workbench-archived-settlement'
import {
  sessionTokenTotals,
  sessionTokensFor
} from '@/lib/task-workbench/task-workbench-session-totals'
import {
  selectProviders,
  sessionTokenClaims
} from '@/lib/task-workbench/task-workbench-usage-providers'
import type { JoinAgentInput } from '@/lib/task-workbench/task-workbench-selector-types'
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
 * One named gap, deliberately not guessed (M1 scope, not P1b):
 * - `attribution: null` — the `ambiguous_session` decision lives in
 *   `resolveAutomationRunUsage` (main process), which a renderer hook cannot
 *   call. The session-level ambiguity verdict is M1's; the hook never claims
 *   `none` on its own.
 *
 * Since §7.12 the delivery evidence is no longer a gap: each workspace's own
 * `review` (number + state) is the one source this renderer really has, so the
 * hook hands over exactly that as a PR fact. Commits / checks / review verdicts
 * still have no source here, and an absent field stays absent — the type marks
 * them optional so nothing has to invent a `0` to fill the shape.
 */

export type TaskWorkbenchViewArgs = {
  /** Repo id of the detail page; null disables the hook. */
  repoId: string | null
  /** Issue or PR number of the detail page. */
  number: number
  itemType: 'issue' | 'pr'
  /** Page title; the view has no way to derive it. */
  title: string
  /** Tracker state + url, when the page knows it. The detail page also knows the
   *  item's number and hands it over for an issue page (§7.12 A3); a PR page's
   *  tracker names the PR, so it carries none. */
  tracker?: { state: 'open' | 'closed'; url: string; number?: number }
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

  // The page's own item. The pair is the identity's item scope, not `number`
  // alone: the link columns are typed, so the type decides which one counts
  // (issue #38).
  const item = useMemo<TaskWorkbenchItem>(() => ({ type: itemType, number }), [itemType, number])

  // The task's own durable record (issue #36), read before the identity because a
  // deleted workspace is still evidence that this item ran: with no provider
  // identity on the page and no workspace left, the record is the only thing that
  // can name the closed task instead of showing the never-started notice (issue
  // #38 review). The page's provider is passed when it has one, so the lookup is
  // exact instead of the ambiguous provider-less suffix scan.
  const taskRecord = useTaskRecords(
    repoId === null
      ? null
      : {
          repoId,
          itemType,
          number,
          ...(taskSourceContext?.provider ? { provider: taskSourceContext.provider } : {})
        },
    // Any change to this repo's workspace list can change the record: a removal
    // settles it, an archive rewrites a binding.
    worktrees
  )

  // A binding the store no longer lists is a deleted workspace; the identity
  // selector may name the task after it when no live or archived row is left
  // (issue #38).
  const removedWorktreeIds = useMemo(() => {
    const record = taskRecord.record
    if (!record || worktrees === undefined) {
      return []
    }
    const live = new Set(worktrees.map((worktree) => worktree.id))
    return record.bindings
      .filter((binding) => !live.has(binding.worktreeId))
      .map((binding) => binding.worktreeId)
  }, [taskRecord.record, worktrees])

  // Provenance the selectors read, projected once. Archived rows are handed over
  // as such; since issue #31 they are a fallback identity rather than a refusal,
  // because a closed task whose only workspace was archived still has a name.
  const identityWorktrees = useMemo(
    () =>
      (worktrees ?? []).map((worktree) => ({
        worktreeId: worktree.id,
        isArchived: worktree.isArchived,
        linkedIssue: worktree.linkedIssue,
        linkedPR: worktree.linkedPR,
        linkedWorkItem: worktree.linkedWorkItem,
        linkedTaskSourceContext: worktree.linkedTaskSourceContext
      })),
    [worktrees]
  )

  const resolution = useMemo(
    () =>
      resolveTaskIdentity({
        taskSourceContext: taskSourceContext ?? null,
        item,
        historyWorktreeIds: removedWorktreeIds,
        worktrees: identityWorktrees
      }),
    [identityWorktrees, taskSourceContext, item, removedWorktreeIds]
  )

  // The task's workspaces are chosen per item, not from the identity's name: the
  // identity is evidence for naming (its provider segment is repo-scoped and its
  // tracker key carries the item) and reading its matches as a set is what
  // listed every branch of the repo in every issue's tab (issue #38). Archived
  // rows are included on purpose (issue #31 history) and zero matches stays zero.
  // The provider is the page's own, exactly what the list row's badge passes;
  // when the page has none there is no authority to scope by host, so both entry
  // points scope by the item links alone instead of guessing from a worktree.
  const taskWorktrees = useMemo(() => {
    if (!resolution) {
      return []
    }
    const provider = taskSourceContext?.providerIdentity ?? null
    const selected = new Set(
      selectTaskItemWorktrees(identityWorktrees, item, provider).map(
        (worktree) => worktree.worktreeId
      )
    )
    return (worktrees ?? []).filter((worktree) => selected.has(worktree.id))
  }, [resolution, identityWorktrees, worktrees, item, taskSourceContext])

  // The archived worktrees of THIS task: the dashboard board never includes
  // them, but a closed task's history needs their rows (issue #31).
  const archivedTaskWorktreeIds = taskWorktrees
    .filter((worktree) => worktree.isArchived)
    .map((worktree) => worktree.id)

  // The delivery confirm's default target branch: the repo's main worktree
  // branch, and only when the store named that worktree (`isMainWorktree` +
  // `branch`). `Worktree.branch` keeps the ref `git worktree list` reports
  // (`refs/heads/<name>`), and the form asks a person for a branch name that is
  // then handed to `git`/`gh` as one, so only the name is kept. An unscanned or
  // detached main worktree leaves it absent, so the form starts empty and asks
  // instead of naming `main` (§7.11.3 rule 3).
  const mainRef = (worktrees ?? []).find((worktree) => worktree.isMainWorktree)?.branch
  const targetBranchDefault = mainRef?.replace(/^refs\/heads\//, '').trim() || undefined

  // The in-window dashboard projection: one card per agent, one workspace per
  // active worktree (plus this task's archived ones). Reusing this hook is the
  // point (development-plan §2): a second row pipeline would give the workbench
  // its own bucket and label rules.
  const snapshot = useLiveDashboardSnapshot({
    includeArchivedWorktreeIds: archivedTaskWorktreeIds
  })
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
    // Active workspaces reuse the value the snapshot already projected. Archived
    // ones are now projected too (the snapshot was asked for this task's
    // archived ids), so both read from one pipeline.
    const projected = new Map<string, DashboardWorkspace>(
      (snapshot.workspaces ?? []).map((workspace) => [workspace.worktreeId, workspace])
    )
    const joinedWorktrees = taskWorktrees.map((worktree) => {
      const workspace = projected.get(worktree.id)
      // The store's own activity signal (the sidebar's "Recent" key): newest
      // wins the default workspace, and 0 can only lose that comparison.
      const base = workspace ?? projectMissingWorkspace(repo, worktree)
      const branchName = workspaceBranchName(base.workspaceKind, worktree)
      return {
        ...base,
        isArchived: worktree.isArchived,
        lastActivityAt: worktree.lastActivityAt,
        ...(branchName ? { branchName } : {}),
        // The delivery entry's eligibility (§7.11.3 rule 7 / A9): the sidebar
        // already hides a primary checkout from its archivable targets, and this
        // is the same existing store fact, carried so the task-page route can
        // apply the same rule (no new store read).
        isMainWorktree: worktree.isMainWorktree
      }
    })
    const activeWorktrees = joinedWorktrees.filter((workspace) => !workspace.isArchived)
    const activeIds = activeWorktrees.map((workspace) => workspace.worktreeId)
    const archivedIds = joinedWorktrees
      .filter((workspace) => workspace.isArchived)
      .map((workspace) => workspace.worktreeId)
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
    // (README §7.5). Same session id under two providers is ambiguous, not
    // additive; see `sessionTokenTotals`, which owns that rule and its test.
    const sessionTotals = sessionTokenTotals(
      sessionTokenClaims({
        claude: claudeSessions,
        codex: codexSessions,
        opencode: openCodeSessions,
        muse: museSessions
      })
    )
    const agentUsage: AgentUsageEntry[] = []
    for (const worktreeId of activeIds) {
      for (const card of cards.get(worktreeId) ?? []) {
        const sessionId = agentStatusByPaneKey[card.paneKey]?.providerSession?.id
        const tokens = sessionTokensFor(sessionTotals, sessionId)
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
    // Archived rows are included so the History fold can state them; their token
    // figure comes from the settlement the record froze for that workspace (issue
    // #53), which an active row never needs. Keyed by `worktreeId|hostId` first,
    // so two hosts for one worktree cannot overwrite each other.
    const archivedTokens = archivedRowTokens({
      archivedWorktreeIds: archivedIds,
      cardsByWorktree: cards,
      bindings: taskRecord.record?.bindings ?? []
    })
    // Per-row facts a projected card cannot carry. `outcome` goes through
    // `isAgentJournalTurnOutcome` instead of a cast, so an absent or unexpected
    // verdict stays unknown and a plain Stop is never read as success.
    const agentsByWorktree: Record<string, JoinAgentInput[]> = {}
    for (const worktreeId of [...activeIds, ...archivedIds]) {
      agentsByWorktree[worktreeId] = (cards.get(worktreeId) ?? []).map((card) => {
        const entry = agentStatusByPaneKey[card.paneKey]
        const verdict = entry?.mainAgent?.outcome
        const tokens = usage.agentTokens[card.paneKey] ?? archivedTokens.get(card.paneKey)
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
      // §7.12: each workspace's own review, and only that.
      deliveryByWorktree: deliveryEvidenceByWorktree(joinedWorktrees),
      // Named gap: an explicit primary needs persistence (M2b), so the join
      // reports `recent-activity` / `none` and never claims a user choice.
      primaryWorktreeId: undefined
    })
    // A deleted worktree left the store but not the persisted record (issue
    // #36). The record is what still names it, its sessions and the usage that
    // was settled before it became unreadable; a record with nothing removed
    // leaves the join's answer exactly as it was.
    // Why the whole repo list and not `joinedWorktrees`: presence is "does this
    // workspace still exist", not "does it still belong to this task". An
    // unloaded list (undefined) is not evidence of anything, so the join's answer
    // stands rather than labelling every binding `Removed`.
    // The `<key>:<id>` ids the join's own rows already speak for, so a record row
    // for the same session is not printed twice (the live row wins: its clock and
    // outcome are the current ones, the record is a frozen observation). A pane
    // with no provider session has no id, so it dedupes nothing.
    const liveRunSessionIds = join.agents.flatMap((agent) => {
      const session = agentStatusByPaneKey[agent.base.paneKey]?.providerSession
      return session ? [`${session.key}:${session.id}`] : []
    })
    const history =
      worktrees === undefined
        ? join.history
        : mergeTaskRecordHistory({
            history: join.history,
            existingWorktreeIds: worktrees.map((worktree) => worktree.id),
            record: taskRecord.record,
            liveRunSessionIds
          })

    return {
      identity: resolution.identity,
      title,
      ...(tracker ? { tracker } : {}),
      defaultWorkspace: join.defaultWorkspace,
      agents: join.agents,
      workspaces: join.workspaces,
      spend: usage.spend,
      delivery: join.delivery,
      history,
      historyPending: taskRecord.pending,
      ...(targetBranchDefault ? { targetBranchDefault } : {})
    }
  }, [
    resolution,
    taskWorktrees,
    targetBranchDefault,
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
    tracker,
    taskRecord,
    // Presence projection reads the repo's whole workspace list.
    worktrees
  ])
}
