import { formatTokens } from '../stats/usage-formatters'
import { tokenText } from './task-workbench-usage-status'
import type { AgentOutcome, AgentRowView, DashboardCard } from './task-workbench-view'

/**
 * The one place the dashboard's four lifecycle buckets become the workbench's
 * three sections (contract §4.2): `attention → attention`, `working → active`,
 * `done | idle → history`. Pure, no React and no store, so the harness can
 * assert the fixture counts through the same function the components use.
 */

export type TaskWorkbenchRowBucket = 'active' | 'attention' | 'history'

export function rowBucket(row: AgentRowView): TaskWorkbenchRowBucket {
  switch (row.base.bucket) {
    case 'attention':
      return 'attention'
    case 'working':
      return 'active'
    case 'done':
    case 'idle':
      return 'history'
  }
}

export type TaskWorkbenchRowSection = {
  bucket: TaskWorkbenchRowBucket
  rows: AgentRowView[]
}

/** Fixed section order; every bucket is returned even when empty so callers do
 *  not branch on length. Input order is preserved inside each bucket. */
export const TASK_WORKBENCH_ROW_BUCKET_ORDER: readonly TaskWorkbenchRowBucket[] = [
  'active',
  'attention',
  'history'
]

export function projectRowSections(agents: AgentRowView[]): TaskWorkbenchRowSection[] {
  const byBucket: Record<TaskWorkbenchRowBucket, AgentRowView[]> = {
    active: [],
    attention: [],
    history: []
  }
  for (const agent of agents) {
    byBucket[rowBucket(agent)].push(agent)
  }
  return TASK_WORKBENCH_ROW_BUCKET_ORDER.map((bucket) => ({ bucket, rows: byBucket[bucket] }))
}

export function countRowBuckets(agents: AgentRowView[]): {
  agents: number
  activeAgents: number
  attentionAgents: number
  historyAgents: number
} {
  let activeAgents = 0
  let attentionAgents = 0
  let historyAgents = 0
  for (const agent of agents) {
    switch (rowBucket(agent)) {
      case 'active':
        activeAgents += 1
        break
      case 'attention':
        attentionAgents += 1
        break
      case 'history':
        historyAgents += 1
        break
    }
  }
  return { agents: agents.length, activeAgents, attentionAgents, historyAgents }
}

/** The row's render input: the untouched snapshot card plus the workbench-only
 *  overlay. `showsDelivered` is `outcome === 'success'` and nothing else — a
 *  failed or cancelled turn is never "Delivered" (contract §4.4, F8), and a
 *  missing outcome is not evidence of success either. */
export type TaskWorkbenchRowView = {
  base: DashboardCard
  tokenText: { text: string; unavailable: boolean }
  outcome?: AgentOutcome
  workspaceLabel?: string
  showsDelivered: boolean
}

export function projectAgentRow(
  row: AgentRowView,
  opts: { showWorkspaceLabel: boolean }
): TaskWorkbenchRowView {
  // Why: W1 owns availability and returns plain digits; the compact suffix is a
  // display concern, so it is applied once here with the existing formatter
  // instead of letting the component parse digits back into a number.
  const status = tokenText(row.tokens)
  const display =
    row.tokens.kind === 'unavailable'
      ? status
      : { text: formatTokens(row.tokens.tokens), unavailable: false }

  return {
    base: row.base,
    tokenText: display,
    outcome: row.outcome,
    workspaceLabel: opts.showWorkspaceLabel ? row.workspaceLabel : undefined,
    showsDelivered: row.outcome === 'success'
  }
}
