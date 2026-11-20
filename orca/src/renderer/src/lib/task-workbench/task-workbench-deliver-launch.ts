import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import { getConnectionId } from '@/lib/connection-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import {
  TASK_WORKBENCH_DELIVER_SESSION_LABEL,
  isTaskWorkbenchDeliverSessionName
} from '@/components/task-workbench/task-workbench-deliver-session'

/**
 * The one launch path behind both delivery entries (README §7.11.3 rule 1).
 *
 * Why it exists at all: §7.9 says the workbench does not start agents; §7.11.4
 * is its bounded exception — no agent choice, no branch, no new worktree, one
 * tab in an existing workspace. This module keeps that boundary in one place:
 * it reuses `resolveDefaultAgentForNewTab` + `launchAgentInNewTab` exactly as
 * `start-agent-in-repo-checkout.ts` does, and adds nothing to the wire or disk.
 *
 * Why the session identity is `quickCommandLabel`: task source D2 chose the
 * existing tab field, so "a delivery session exists" is readable from the
 * workbench's own agent rows (`DashboardCard.conversationName`) with no new
 * field, no new persistence and no new RPC.
 */

export type TaskWorkbenchDeliverIntegrationMode = 'pr' | 'local-merge' | 'squash'

/** Existing `LaunchSource` values only; D1 forbids adding one. */
export type TaskWorkbenchDeliverSource = 'task_page' | 'sidebar'

export type TaskWorkbenchDeliverInput = {
  /** The workspace being delivered — never the primary checkout. */
  worktreeId: string
  /** Required; already validated by the caller's form. */
  targetBranch: string
  integrationMode: TaskWorkbenchDeliverIntegrationMode
  archiveAfter: boolean
  source: TaskWorkbenchDeliverSource
}

export type TaskWorkbenchDeliverLaunchResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: 'no-agent' | 'already-delivering' }

/**
 * The frozen no-agent notice (§7.11.3 rule 6: reuse the existing terminal line,
 * never invent a new one). Exported so both delivery hosts — the task-page fact
 * row and the sidebar confirmation — render one pair instead of two copies that
 * can drift (F6).
 */
export const TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE = {
  key: 'auto.components.Terminal.5b2c1a9e44',
  fallback: 'No agent CLI detected — install one or pick a default agent in Settings.'
} as const

/**
 * How each integration mode shapes the change on the source branch. The PR rule
 * is not per mode (it is unconditional in the instruction below): every mode
 * reaches the target branch through a pull request, and the mode only decides
 * the history the PR carries.
 */
const INTEGRATION_MODE_COPY: Record<TaskWorkbenchDeliverIntegrationMode, string> = {
  pr: 'pr (leave the source branch for review; the PR carries it as it is)',
  'local-merge': 'local-merge (the PR carries a merge of the source branch into the target branch)',
  squash: 'squash (the PR carries the change as one squashed commit on the target branch)'
}

/**
 * The fixed delivery instruction. English and code-owned on purpose: it is a
 * hand-off to an agent, not localized interface copy.
 *
 * Frozen content (§7.11.3 rules 3, 7, 8 + worktree-delivery §1–§3, §5): read
 * the skill, verify and get independent review, integrate through a pull
 * request in every mode, never write the primary checkout and never push the
 * target branch directly, stop instead of improvising, and never archive — a
 * human clicks Archive last.
 *
 * Why the PR requirement is a separate, unconditional sentence: the three modes
 * used to differ in *where* integration happened (`local-merge` read as "merge
 * on this machine"), which left "authorized remote/PR workflow" open to a direct
 * push. The mode now only names the history shape the PR carries; an agent that
 * cannot honour that shape through a PR must stop and report.
 */
export function buildTaskWorkbenchDeliverInstruction(
  input: TaskWorkbenchDeliverInput & {
    workspaceLabel?: string
    attention?: readonly string[]
  }
): string {
  const { worktreeId, targetBranch, integrationMode, archiveAfter, workspaceLabel, attention } =
    input
  const workspace = workspaceLabel?.trim() ? `${workspaceLabel.trim()} (${worktreeId})` : worktreeId
  const lines = [
    "Run the worktree-delivery flow for this workspace. Treat this as the operator's delivery request.",
    '',
    `Workspace: ${workspace}`,
    `Target branch: ${targetBranch}`,
    `Integration mode: ${INTEGRATION_MODE_COPY[integrationMode]}`,
    '',
    '1. Read swarm/skills/worktree-delivery/SKILL.md in full before acting.',
    '2. Verify the change in this workspace: run the relevant tests and inspect the actual diff. Get independent review of the change before integrating it.',
    '3. Integrate only through a pull request against the target branch. This is unconditional in every integration mode: never push the target branch directly. Never write the primary checkout.',
    '4. The integration mode only decides how the change is shaped on the source branch; pr leaves the branch for review, and local-merge or squash deliver that history shape through the pull request. If the requested mode cannot be honoured inside this rule, stop and report that instead of improvising, writing the primary checkout, or pushing the target branch directly.',
    '',
    'Do not archive, remove, stop terminals or delete anything. A human clicks Archive as the last step, after your report.'
  ]
  if (archiveAfter) {
    lines.push(
      '',
      'The operator asked to archive this workspace after delivery. Do not archive it yourself; only remind the operator that archiving is their next step.'
    )
  }
  if (attention && attention.length > 0) {
    lines.push('', 'Facts from the workbench (stated only; nothing was stashed, reset or deleted):')
    for (const fact of attention) {
      lines.push(`- ${fact}`)
    }
  }
  return lines.join('\n')
}

/** The marker test the launcher and the state projection must agree on: the
 *  tab field the launcher writes, read back from the live tab model. */
function isDeliverMarkerTab(tab: { quickCommandLabel?: string | null }): boolean {
  return isTaskWorkbenchDeliverSessionName(tab.quickCommandLabel)
}

/**
 * The existing delivery session's tab id in this workspace, or null.
 *
 * Why the unified tabs first: `createTab` publishes the unified tab atomically
 * with the runtime row, so this is the index that is already up to date when a
 * second click lands in the same tick. Terminal rows are the legacy fallback
 * for a partial store shape.
 */
export function findTaskWorkbenchDeliverTabId(worktreeId: string): string | null {
  const state = useAppStore.getState()
  const unified = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(isDeliverMarkerTab)
  if (unified) {
    return unified.id
  }
  const rows = (state.tabsByWorktree?.[worktreeId] ?? []).find(isDeliverMarkerTab)
  return rows?.id ?? null
}

/** Reveal the existing delivery session (the `[ 打开终端 ]` action). */
export function revealTaskWorkbenchDeliverTab(worktreeId: string): boolean {
  const tabId = findTaskWorkbenchDeliverTabId(worktreeId)
  if (tabId === null) {
    return false
  }
  // Why activate first: the tab lives in this workspace's tab list, and the
  // entry can be clicked from a row that is not the active workspace.
  if (activateAndRevealWorktree(worktreeId) === false) {
    return false
  }
  activateTabAndFocusPane(tabId, null)
  return true
}

/**
 * Start the delivery agent in the workspace being delivered.
 *
 * The synchronous store re-check is the second half of the idempotency guard
 * (the projection turning a marker row into `[ 打开终端 ]` is the first): a
 * double click cannot launch twice because the first launch's `createTab` has
 * already published the marker tab by the time this function returns.
 */
export function launchTaskWorkbenchDeliver(
  input: TaskWorkbenchDeliverInput
): TaskWorkbenchDeliverLaunchResult {
  if (findTaskWorkbenchDeliverTabId(input.worktreeId) !== null) {
    return { ok: false, reason: 'already-delivering' }
  }
  const state = useAppStore.getState()
  // Why the connection id: a remote workspace's agents are the remote host's.
  const connectionId = getConnectionId(input.worktreeId)
  const agent = resolveDefaultAgentForNewTab({
    defaultTuiAgent: state.settings?.defaultTuiAgent,
    detectedAgentIds:
      typeof connectionId === 'string'
        ? state.remoteDetectedAgentIds[connectionId]
        : state.detectedAgentIds,
    disabledTuiAgents: state.settings?.disabledTuiAgents
  })
  if (!agent) {
    return { ok: false, reason: 'no-agent' }
  }
  // Why activate first: same reason as the repo-checkout entry — the new tab is
  // created in this worktree's tab list, which may not be the active workspace.
  activateAndRevealWorktree(input.worktreeId)
  const launched = launchAgentInNewTab({
    agent,
    worktreeId: input.worktreeId,
    prompt: buildTaskWorkbenchDeliverInstruction(input),
    promptDelivery: 'submit-after-ready',
    quickCommandLabel: TASK_WORKBENCH_DELIVER_SESSION_LABEL,
    launchSource: input.source
  })
  if (!launched) {
    // No startup plan means no session was started; the entry shows the same
    // existing no-agent copy, so the two collapse into one reported reason.
    return { ok: false, reason: 'no-agent' }
  }
  // A paired host owns the tab; this client has no local id to reveal.
  return {
    ok: true,
    tabId: launched.surface.kind === 'host-published' ? '' : launched.surface.tabId
  }
}
