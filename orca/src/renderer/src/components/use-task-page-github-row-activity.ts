import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { isAgentJournalTurnOutcome } from '../../../shared/agent-turn-outcome'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { useLiveDashboardSnapshot } from '@/components/dashboard/useLiveDashboardSnapshot'
import { taskPageGitHubItemKey } from '@/components/task-page-github-work-item-mutation-registry'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
import type { TaskPageGitHubListProjectionModel } from './use-task-page-github-list-projection'
import { resolveTaskWorkbenchRowActivity } from '@/lib/task-workbench/task-workbench-row-activity'
import type {
  TaskWorkbenchRowActivity,
  TaskWorkbenchRowAgent,
  TaskWorkbenchRowWorktree
} from '@/lib/task-workbench/task-workbench-row-activity'

/**
 * The list-page half of the P3 thin-slice row activity (issue #27): one page-wide
 * projection the rows then read in O(1), instead of one `useTaskWorkbenchView`
 * per row — that hook runs a usage selector plus its own dashboard snapshot, so
 * N rows would pay for N tasks' worth of attribution.
 *
 * Reuse over rewrite (development-plan §2): the agent facts come from the same
 * `useLiveDashboardSnapshot` the dashboard popover and the `Orca` tab already
 * read, and the row rules live in the pure selector. This module only feeds it
 * — store rows in, the selector's input shape out, in store order — and decides
 * nothing about buckets, dots or delivery.
 */

/** The three page-model fields this stage reads. Named so a caller (and the
 *  stage's own test) can hand in exactly these, instead of the whole ~50-field
 *  model chain the page accumulates. */
export type TaskPageGitHubRowActivitySource = Pick<
  TaskPageGitHubListProjectionModel,
  'filteredWorkItems' | 'allWorktrees' | 'repoMap'
>

/** What the stage passes on: the same model, plus the per-row lookup the rows
 *  read. Declared rather than `ReturnType` because the function is generic. */
export type TaskPageGitHubRowActivityModel = TaskPageGitHubListProjectionModel & {
  rowActivityByKey: ReadonlyMap<string, TaskWorkbenchRowActivity>
}

/** What `filteredWorkItems` are: the rows actually painted on this page. Soft
 *  hidden rows are already excluded, so a hidden row cannot keep a badge. */
export function useTaskPageGitHubRowActivity<Model extends TaskPageGitHubRowActivitySource>(
  model: Model
): Model & { rowActivityByKey: ReadonlyMap<string, TaskWorkbenchRowActivity> } {
  const { filteredWorkItems, allWorktrees, repoMap } = model
  const snapshot = useLiveDashboardSnapshot()
  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)
  // Why retained too: a completed agent whose live entry is gone keeps its last
  // entry in this map (`RetainedAgentEntry`), and the dashboard still projects a
  // `done` card for it. Reading the verdict from the live map alone would turn a
  // retained failure into `Delivered`; the same `live ?? retained` precedence is
  // what `retraction-pane-ownership.ts:83` uses.
  const retainedAgentsByPaneKey = useAppStore((state) => state.retainedAgentsByPaneKey)

  const rowActivityByKey = useMemo<ReadonlyMap<string, TaskWorkbenchRowActivity>>(() => {
    // One pass over the snapshot, not one per row: a card names its worktree,
    // and the row lookup below is a map read.
    const agentsByWorktree = new Map<string, TaskWorkbenchRowAgent[]>()
    for (const card of snapshot.cards) {
      // One source per agent: the entry that describes this card, live first and
      // retained second. Status, verdict and boundary never come from two rows.
      const entry =
        agentStatusByPaneKey[card.paneKey] ?? retainedAgentsByPaneKey[card.paneKey]?.entry
      // `outcome` goes through `isAgentJournalTurnOutcome` instead of a cast, so
      // an absent or unexpected verdict stays unknown (same rule as the tab).
      const outcome = entry?.mainAgent?.outcome
      const agent: TaskWorkbenchRowAgent = {
        dotState: card.dotState,
        ...(isAgentJournalTurnOutcome(outcome) ? { outcome } : {}),
        ...(entry?.sessionBoundary === true ? { sessionBoundary: true } : {}),
        // Why: older hosts record a user stop on a `done` row without a
        // `mainAgent` verdict, so `interrupted` is the only evidence there.
        ...(entry?.interrupted === true ? { interrupted: true } : {})
      }
      const existing = agentsByWorktree.get(card.worktreeId)
      if (existing) {
        existing.push(agent)
      } else {
        agentsByWorktree.set(card.worktreeId, [agent])
      }
    }

    const worktrees: TaskWorkbenchRowWorktree[] = allWorktrees.map((worktree) => ({
      worktreeId: worktree.id,
      isArchived: worktree.isArchived,
      linkedTaskSourceContext: worktree.linkedTaskSourceContext,
      repoId: worktree.repoId,
      linkedIssue: worktree.linkedIssue,
      linkedPR: worktree.linkedPR,
      agents: agentsByWorktree.get(worktree.id) ?? []
    }))

    // One context per repo, not per row: the list derives every row's context
    // from its repo, so recomputing it 50 times would build 50 identical
    // projections of the same repo.
    const sourceContextByRepo = new Map<string, TaskSourceContext | null>()
    const rows = filteredWorkItems.map((item) => {
      if (!sourceContextByRepo.has(item.repoId)) {
        sourceContextByRepo.set(
          item.repoId,
          getTaskPageRepoSourceContext(repoMap.get(item.repoId) ?? null, 'github')
        )
      }
      return {
        rowKey: taskPageGitHubItemKey(item.repoId, item.id),
        repoId: item.repoId,
        itemType: item.type,
        itemNumber: item.number,
        taskSourceContext: sourceContextByRepo.get(item.repoId) ?? null
      }
    })

    return resolveTaskWorkbenchRowActivity({ rows, worktrees })
  }, [
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    allWorktrees,
    filteredWorkItems,
    repoMap,
    snapshot
  ])

  // Why the assertion: the page model grows by mutation (every
  // `use-task-page-*` stage narrows `typeof model` the same way), so the field
  // added here has no other declaration; the object is the caller's own model.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chained model object is the one the caller passed; this stage only adds the field it reads back.
  const nextModel = model as Model & {
    rowActivityByKey: ReadonlyMap<string, TaskWorkbenchRowActivity>
  }
  nextModel.rowActivityByKey = rowActivityByKey
  return nextModel
}
