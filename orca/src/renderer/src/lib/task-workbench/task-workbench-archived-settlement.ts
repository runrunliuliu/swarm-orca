import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type {
  TaskUsageSettlement,
  TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import type { AgentTokenView } from '@/components/task-workbench/task-workbench-view'
import { archivedRowsTokens } from './task-workbench-history-settlement'

/**
 * The archived-workspace side of the token figures (issue #53 A1/A2).
 *
 * An archived worktree has no live scan of its own any more, so its per-agent
 * rows come from the settlement the record froze for that workspace. This module
 * only looks the settlement up — `archivedRowsTokens` owns which figure a row may
 * state — so a row can never print a share nobody measured.
 */

/** One binding's settlement, kept with the host that recorded it so the two
 *  keys can be told apart before the collapse. */
type RecordedSettlement = {
  binding: TaskWorkspaceBinding
  settlement: TaskUsageSettlement
}

/** Settlements keyed by `worktreeId|hostId`, then collapsed to the one this page
 *  can speak for.
 *
 *  Keying by `worktreeId` alone let two hosts that each recorded a settlement for
 *  one worktree overwrite each other, and which one survived depended on binding
 *  order (N1). Two hosts now keep two entries; the collapse prefers the local
 *  host, because that is the machine the row is read on and the one the store's
 *  worktrees describe, then the newest collection. */
export function settlementsByWorktree(
  bindings: readonly TaskWorkspaceBinding[]
): Map<string, TaskUsageSettlement> {
  const byHost = new Map<string, RecordedSettlement>()
  for (const binding of bindings) {
    const settlement = binding.usageSettlement
    if (settlement === undefined) {
      continue
    }
    const key = `${binding.worktreeId}|${binding.hostId}`
    const stored = byHost.get(key)
    // Same worktree and host: a later collection is the observation that saw
    // more, and an equal timestamp keeps the stored one (no order dependence).
    if (stored === undefined || settlement.collectedAt > stored.settlement.collectedAt) {
      byHost.set(key, { binding, settlement })
    }
  }
  const byWorktree = new Map<string, RecordedSettlement>()
  for (const entry of byHost.values()) {
    const stored = byWorktree.get(entry.binding.worktreeId)
    if (stored === undefined) {
      byWorktree.set(entry.binding.worktreeId, entry)
      continue
    }
    const entryLocal = entry.binding.hostId === LOCAL_EXECUTION_HOST_ID
    const storedLocal = stored.binding.hostId === LOCAL_EXECUTION_HOST_ID
    const entryWins =
      entryLocal !== storedLocal
        ? entryLocal
        : entry.settlement.collectedAt > stored.settlement.collectedAt
    if (entryWins) {
      byWorktree.set(entry.binding.worktreeId, entry)
    }
  }
  return new Map(
    [...byWorktree.values()].map((entry) => [entry.binding.worktreeId, entry.settlement])
  )
}

/** The token figure of every archived row on the page, by the row's pane key.
 *  A row whose workspace never settled a figure gets `unavailable/unattributed`
 *  (the vocabulary's "no source"), never `0`. */
export function archivedRowTokens(args: {
  archivedWorktreeIds: readonly string[]
  cardsByWorktree: ReadonlyMap<string, readonly DashboardCard[]>
  bindings: readonly TaskWorkspaceBinding[]
}): Map<string, AgentTokenView> {
  const settlements = settlementsByWorktree(args.bindings)
  const byPaneKey = new Map<string, AgentTokenView>()
  for (const worktreeId of args.archivedWorktreeIds) {
    const rows = args.cardsByWorktree.get(worktreeId) ?? []
    const figures = archivedRowsTokens({
      agentTypes: rows.map((card) => card.agentType),
      settlement: settlements.get(worktreeId)
    })
    rows.forEach((card, index) => byPaneKey.set(card.paneKey, figures[index]))
  }
  return byPaneKey
}
