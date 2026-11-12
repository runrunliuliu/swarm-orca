import type { AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'

export type SummaryAgentGroup = {
  state: AgentDotState
  agents: DashboardAgentRowData[]
}

/**
 * Summary vocabulary: the dot states plus `no-evidence`, which shares the dashed-amber dot
 * with `unverifiable` but must not share its wording — one pane never reported, the other
 * reported and went quiet. Counts and labels use this key; groups stay on the dot state so
 * the pill renders one glyph per visual state.
 */
export type SummaryAgentState = AgentDotState | 'no-evidence'

const SUMMARY_STATE_ORDER: SummaryAgentState[] = [
  'waiting',
  'blocked',
  // Why: a failed main agent outranks live work; a pending question still comes first.
  'failed',
  'working',
  'monitoring',
  'interrupted',
  'done',
  // Why: below every reporting state, above true idle — the pane is still held.
  'unverifiable',
  'no-evidence',
  'idle'
]

export function getAgentDotState(agent: DashboardAgentRowData): AgentDotState {
  return agentRowDisplayDotState(agent)
}

/** The summary key for one row: `no-evidence` keeps its own wording off the dot vocabulary. */
function summaryStateFor(agent: DashboardAgentRowData): SummaryAgentState {
  return agent.state === 'no-evidence' ? 'no-evidence' : getAgentDotState(agent)
}

export function formatSummaryStateLabel(state: SummaryAgentState): string {
  switch (state) {
    case 'waiting':
      return 'waiting'
    case 'blocked':
      return 'blocked'
    case 'interrupted':
      return 'interrupted'
    case 'failed':
      return 'failed'
    case 'working':
      return 'working'
    case 'monitoring':
      return 'monitoring'
    case 'done':
      return 'done'
    case 'idle':
      return 'idle'
    case 'unverifiable':
      return 'not reporting'
    // Why: says what Orca lacks (a status) instead of borrowing the stale-report wording;
    // for a launched agent this is the hooks-not-installed case.
    case 'no-evidence':
      return 'no status reported'
    case 'permission':
      return 'needs attention'
  }
}

export function buildSummaryAgentGroups(agents: DashboardAgentRowData[]): SummaryAgentGroup[] {
  const groups = new Map<AgentDotState, DashboardAgentRowData[]>()
  for (const agent of agents) {
    const dotState = getAgentDotState(agent)
    const group = groups.get(dotState)
    if (group) {
      group.push(agent)
    } else {
      groups.set(dotState, [agent])
    }
  }
  return SUMMARY_STATE_ORDER.flatMap((state) => {
    // Why: pills group by the glyph that is actually rendered, so `no-evidence` rows sit in
    // the shared dashed-amber group; only the count/label text splits them apart.
    if (state === 'no-evidence') {
      return []
    }
    const groupAgents = groups.get(state)
    return groupAgents ? [{ state, agents: groupAgents }] : []
  })
}

export function summarizeAgents(agents: DashboardAgentRowData[], subjectLabel: string): string {
  const counts = new Map<SummaryAgentState, number>()
  for (const agent of agents) {
    const state = summaryStateFor(agent)
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const parts = SUMMARY_STATE_ORDER.flatMap((state) => {
    const count = counts.get(state) ?? 0
    if (count === 0) {
      return []
    }
    const label = formatSummaryStateLabel(state)
    return `${count} ${label}`
  })
  if (parts.length === 1) {
    const onlyStatusLabel = parts[0].replace(/^\d+\s+/, '')
    return agents.length === 1
      ? `${subjectLabel} ${onlyStatusLabel}`
      : `All ${subjectLabel} ${onlyStatusLabel}`
  }
  return `${subjectLabel}: ${parts.join(', ')}`
}

export function summarizeAgentIdentities(agents: DashboardAgentRowData[]): string {
  return agents
    .map((agent) => {
      const agentLabel = formatAgentTypeLabel(agent.agentType)
      const stateLabel = formatSummaryStateLabel(summaryStateFor(agent))
      return `${agentLabel} ${stateLabel}`
    })
    .join('; ')
}

export function selectSummaryGroupIconAgents(
  agents: DashboardAgentRowData[],
  maxCount: number
): DashboardAgentRowData[] {
  const groups = new Map<string, { agents: DashboardAgentRowData[]; firstIndex: number }>()
  agents.forEach((agent, index) => {
    const key = agent.agentType ?? 'unknown'
    const group = groups.get(key)
    if (group) {
      group.agents.push(agent)
    } else {
      groups.set(key, { agents: [agent], firstIndex: index })
    }
  })
  const sortedGroups = [...groups.values()].sort(
    (a, b) => b.agents.length - a.agents.length || a.firstIndex - b.firstIndex
  )
  const selected: DashboardAgentRowData[] = []
  for (const group of sortedGroups) {
    if (selected.length >= maxCount) {
      break
    }
    selected.push(group.agents[0])
  }
  return selected
}
