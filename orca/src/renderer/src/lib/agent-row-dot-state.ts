import type { AgentDotState } from '@/components/AgentStateDot'
import type { AgentChildRowModel } from '../../../shared/agent-child-row-model'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import type { AgentStatusEntry, AgentWorkingMode } from '../../../shared/agent-status-types'
import type { AgentRowState } from './agent-row-decay-state'

/**
 * Map an agent row's state onto the shared state-indicator vocabulary. One copy so the
 * sidebar card, the dashboard row and the notes send menu cannot drift on a new member.
 */
export function agentRowDotState(
  state: AgentRowState,
  workingMode?: AgentWorkingMode
): AgentDotState {
  switch (state) {
    case 'working':
      return workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
    case 'unverifiable':
      return state
    // Why: `no-evidence` is the same dot as `unverifiable` on purpose — a dashed amber
    // ring meaning "incomplete information". The dot vocabulary is shared with the
    // dashboard/card snapshot published to main and to pop-out windows that may predate a
    // new member (dashboard-payload-validation.ts drops unknown values), so the split
    // lives in the row state and the text, not in a new glyph.
    case 'no-evidence':
      return 'unverifiable'
  }
  return 'idle'
}

/**
 * The dot an agent row renders: a child row's own, else the main agent's verdict (a stop or a
 * failure, which a failure shows even while subagents still run), else its state.
 */
export function agentRowDisplayDotState(agent: {
  state: AgentRowState
  entry: Pick<AgentStatusEntry, 'state' | 'interrupted' | 'mainAgent' | 'workingMode'>
  childRow?: Pick<AgentChildRowModel, 'displayState'>
}): AgentDotState {
  if (agent.childRow) {
    return agent.childRow.displayState
  }
  return (
    agentVerdictDisplayMark(agent.entry) ?? agentRowDotState(agent.state, agent.entry.workingMode)
  )
}
