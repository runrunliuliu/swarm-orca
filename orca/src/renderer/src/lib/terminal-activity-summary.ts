import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { resolveAgentActivitySummary } from '../../../shared/terminal-activity-summary'
import { isExplicitAgentStatusFresh } from './pane-agent-evidence'
import { parseAgentStatusPaneKey } from '@/components/tab-bar/terminal-tab-activity-status'

/**
 * Per-tab "what is it doing" text, folded from the pane status rows the tab owns.
 *
 * Same grouping rule as the tab status glyph (see resolveTerminalTabActivityStatus): a tab is a
 * container of panes, freshness comes from the hook row, and one bucket is built per store
 * snapshot so every tab's selector stays O(1). Kept beside the status resolver rather than
 * inside it because the glyph answers "is it busy" while this answers "busy with what".
 */

type ActivitySummaryCache = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
  agentStatusEpoch: number | undefined
  summariesByTabId: Map<string, string>
}

let summaryCache: ActivitySummaryCache | null = null

export const EMPTY_ACTIVITY_SUMMARIES: ReadonlyMap<string, string> = new Map()

function buildActivitySummariesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
): Map<string, string> {
  const now = Date.now()
  // Newest live pane wins: a split tab with a finished pane and a working pane must describe the work.
  const winnerByTabId = new Map<string, { entry: AgentStatusEntry; rank: number }>()
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey ?? {})) {
    const identity = parseAgentStatusPaneKey(entry.paneKey || paneKey)
    if (!identity) {
      continue
    }
    // Why: hydrated-but-unconfirmed and stale rows are not authority; a slept pane must not keep
    // claiming to run a tool it never started here (same gate as the status glyph).
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    const rank = entry.stateStartedAt || entry.updatedAt || 0
    const previous = winnerByTabId.get(identity.tabId)
    if (!previous || rank >= previous.rank) {
      winnerByTabId.set(identity.tabId, { entry, rank })
    }
  }

  const summariesByTabId = new Map<string, string>()
  for (const [tabId, winner] of winnerByTabId) {
    const summary = resolveAgentActivitySummary(winner.entry)
    if (summary) {
      summariesByTabId.set(tabId, summary)
    }
  }
  return summariesByTabId
}

function getActivitySummariesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  agentStatusEpoch: number | undefined
): Map<string, string> {
  // Why: freshness is time-based and the store bumps agentStatusEpoch at the stale boundary
  // without replacing the map, so both are part of the identity (mirrors the flags cache).
  if (
    summaryCache &&
    summaryCache.agentStatusByPaneKey === agentStatusByPaneKey &&
    summaryCache.agentStatusEpoch === agentStatusEpoch
  ) {
    return summaryCache.summariesByTabId
  }
  const summariesByTabId = buildActivitySummariesByTabId(agentStatusByPaneKey)
  summaryCache = { agentStatusByPaneKey, agentStatusEpoch, summariesByTabId }
  return summariesByTabId
}

/** One-line activity summary for a tab, or '' when the pane has nothing fresh to report. */
export function resolveTerminalTabActivitySummary({
  tabId,
  agentStatusByPaneKey,
  agentStatusEpoch
}: {
  tabId: string
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  agentStatusEpoch?: number
}): string {
  return getActivitySummariesByTabId(agentStatusByPaneKey, agentStatusEpoch).get(tabId) ?? ''
}

/** Whole-map form for callers that project many tabs at once (palette, group headers). */
export function getTerminalActivitySummariesByTabId({
  agentStatusByPaneKey,
  agentStatusEpoch
}: {
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  agentStatusEpoch?: number
}): ReadonlyMap<string, string> {
  if (!agentStatusByPaneKey) {
    return EMPTY_ACTIVITY_SUMMARIES
  }
  return getActivitySummariesByTabId(agentStatusByPaneKey, agentStatusEpoch)
}

/** Test-only: clear the memoized per-tab summary cache between cases. */
export function resetTerminalActivitySummaryCacheForTest(): void {
  summaryCache = null
}
