import type { AgentDotState } from '@/components/AgentStateDot'
import { AgentStateDot } from '@/components/AgentStateDot'
import type { AgentOutcome } from './task-workbench-view'

/**
 * F8's failure / boundary presentation, split out of `TaskWorkbenchAgentRow` so
 * it can be rendered and asserted on its own: the row imports `AgentKanbanCard`,
 * whose graph reaches `lib/agent-catalog.tsx` and a `resources/` asset that the
 * sparse task checkout does not carry, so a test that mounted the whole row
 * could not run here.
 *
 * Owned by the overlay, not `shared/` (P1b decision, `p1a.md` §6.1/§9 Decision 1):
 * - `DashboardCardDotState` is the published snapshot vocabulary and travels to
 *   pop-out windows through `dashboard-payload-validation.ts`, which drops
 *   unknown members; adding `failed` there is a wire-adjacent change.
 * - `AgentDotState` already carries `failed`, `interrupted` and `unverifiable`,
 *   and is already the one dot vocabulary the sidebar and the dashboard row
 *   share, so no new vocabulary is invented.
 *
 * Mapping (F8): a failure outranks everything, because a main agent that failed
 * while subagents still run is news; a cancellation reads as interrupted; a
 * session boundary with no verdict reads as unverifiable (D12: a boundary is not
 * a completed turn, so it must never read as delivered); a clean success keeps
 * the card's own `done` dot, which is truthful. No copy: `AgentStateDot` owns
 * the label and tooltip.
 */
export type OverlayDotRow = { outcome?: AgentOutcome; sessionBoundary?: boolean }

export function taskWorkbenchOverlayDotState(row: OverlayDotRow): AgentDotState | null {
  if (row.outcome === 'failure') {
    return 'failed'
  }
  if (row.outcome === 'cancellation') {
    return 'interrupted'
  }
  if (row.outcome === undefined && row.sessionBoundary === true) {
    return 'unverifiable'
  }
  return null
}

/** The overlay mark itself. `data-dot-state` is on the element that renders the
 *  dot's content, so the rendered harness counts a real mark and never an empty
 *  wrapper. */
export function TaskWorkbenchAgentRowDot({ row }: { row: OverlayDotRow }): React.JSX.Element | null {
  const state = taskWorkbenchOverlayDotState(row)
  if (!state) {
    return null
  }
  return (
    <span
      data-testid="task-workbench-agent-row-dot"
      data-dot-state={state}
      className="inline-flex"
    >
      <AgentStateDot state={state} />
    </span>
  )
}
