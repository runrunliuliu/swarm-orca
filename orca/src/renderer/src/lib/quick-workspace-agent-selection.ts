import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSourceSelectionKind } from '../../../shared/new-workspace/workspace-source'
import {
  isTuiAgentEnabled,
  pickTuiAgent,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../shared/tui-agent-selection'

// Why: deriving a workspace from an issue/PR gets its own default instead of a
// change to TUI_AGENT_AUTO_PICK_ORDER — that order also drives source-control AI
// actions and dashboard launches, whose fallback must stay untouched.
const TASK_SOURCE_DEFAULT_TUI_AGENT = 'pi' as const satisfies TuiAgent

// Why: only work items are task source context. A branch pick or a plain typed
// name must keep the global default, so the kind list stays explicit.
export function isTaskSourceWorkItemSelectionKind(
  kind: WorkspaceSourceSelectionKind | null | undefined
): boolean {
  switch (kind) {
    case 'github-issue':
    case 'github-pr':
    case 'gitlab-issue':
    case 'gitlab-mr':
    case 'linear':
    case 'jira':
      return true
    default:
      return false
  }
}

export type QuickWorkspaceAgentOptions = {
  /** True when the composer is deriving this workspace from an issue/PR/MR. */
  taskSourceWorkItem?: boolean
}

export function pickQuickWorkspaceAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detectedAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null,
  options?: QuickWorkspaceAgentOptions
): TuiAgent | null {
  const candidates = detectedAgentIds ?? TUI_AGENT_AUTO_PICK_ORDER
  if (options?.taskSourceWorkItem && preferred !== 'blank') {
    // Why this priority: the work-item default outranks the global
    // `defaultTuiAgent` because the request is scoped to this path, and it loses
    // to the in-dialog override (handled by the caller). `blank` still wins — it
    // is the user explicitly asking for workspaces without an agent. Availability
    // is checked directly instead of through `pickTuiAgent`, whose own auto-order
    // fallback would report another agent as if it were this default.
    if (
      isQuickWorkspaceAgentAvailable(
        TASK_SOURCE_DEFAULT_TUI_AGENT,
        detectedAgentIds,
        disabledTuiAgents
      )
    ) {
      return TASK_SOURCE_DEFAULT_TUI_AGENT
    }
  }
  return pickTuiAgent(preferred, candidates, disabledTuiAgents)
}

function hasDetectedAgent(detectedAgentIds: Iterable<TuiAgent>, agent: TuiAgent): boolean {
  if (detectedAgentIds instanceof Set) {
    return detectedAgentIds.has(agent)
  }
  for (const detectedAgentId of detectedAgentIds) {
    if (detectedAgentId === agent) {
      return true
    }
  }
  return false
}

function isQuickWorkspaceAgentAvailable(
  agent: TuiAgent,
  detectedAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null
): boolean {
  if (!isTuiAgentEnabled(agent, disabledTuiAgents)) {
    return false
  }
  return detectedAgentIds === null || hasDetectedAgent(detectedAgentIds, agent)
}

export function resolveQuickWorkspaceAgentSelection({
  quickAgentOverride,
  preferredQuickAgent,
  detectedAgentIds,
  disabledTuiAgents
}: {
  quickAgentOverride: TuiAgent | null | undefined
  preferredQuickAgent: TuiAgent | null
  detectedAgentIds: Iterable<TuiAgent> | null
  disabledTuiAgents?: Iterable<unknown> | null
}): {
  quickAgent: TuiAgent | null
  quickAgentOverride: TuiAgent | null | undefined
} {
  if (quickAgentOverride === undefined || quickAgentOverride === null) {
    return {
      quickAgent: quickAgentOverride === undefined ? preferredQuickAgent : null,
      quickAgentOverride
    }
  }
  if (isQuickWorkspaceAgentAvailable(quickAgentOverride, detectedAgentIds, disabledTuiAgents)) {
    return { quickAgent: quickAgentOverride, quickAgentOverride }
  }
  return { quickAgent: preferredQuickAgent, quickAgentOverride: preferredQuickAgent }
}
