import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { recordTaskWorkbenchArchiveIntent } from './task-workbench-deliver-archive-intent'
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
  /** Whether merging the PR was authorized (§7.12 D1). Off means: create the PR,
   *  stop, and report the merge as not authorized. */
  mergePullRequest: boolean
  /** Whether closing the task's issue was authorized. Only meaningful together
   *  with `issueNumber`: without a number there is nothing to close and the
   *  instruction says so instead of guessing one. */
  closeIssue: boolean
  /** The page's own item number, taken from the view (A3). Never derived here. */
  issueNumber?: number
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
 * Since §7.12 it is a pipeline with an end (§5 of the plan): verify + review →
 * integrate through a PR → merge when authorized → close the issue when
 * authorized → mark the workspace completed → report. Two rules survive from
 * §7.11.3: every mode goes through a pull request (never a direct push, never
 * the primary checkout), and the agent still does not archive itself — Orca
 * archives after it observes the completion fact.
 *
 * Unauthorized steps are absent, and the instruction says they are absent: an
 * unticked merge or issue close must stop and be reported as "not authorized",
 * not silently performed because the sentence was merely omitted.
 */
export function buildTaskWorkbenchDeliverInstruction(
  input: TaskWorkbenchDeliverInput & {
    workspaceLabel?: string
    attention?: readonly string[]
  }
): string {
  const {
    worktreeId,
    targetBranch,
    integrationMode,
    mergePullRequest,
    closeIssue,
    issueNumber,
    archiveAfter,
    workspaceLabel,
    attention
  } = input
  const workspace = workspaceLabel?.trim() ? `${workspaceLabel.trim()} (${worktreeId})` : worktreeId
  const issue = `#${issueNumber ?? '<n>'}`
  // The completion comment states only what this delivery was authorized to do;
  // an unticked close must not be reported as closed.
  const issuePart = closeIssue && issueNumber !== undefined ? `; issue ${issue} closed` : ''
  // Same rule for the merge: the template must not claim a merge the operator
  // did not authorize, even though the agent is told to adjust it to the facts.
  const deliveredComment = mergePullRequest
    ? `delivered: PR #<number> merged as <sha>${issuePart}`
    : `delivered: PR #<number> (merge not authorized)${issuePart}`
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
    'Authorized follow-up steps, in this order:',
    mergePullRequest
      ? `5. Merge the pull request: \`gh pr merge <number> ${mergeFlag(integrationMode)}\`. Afterwards verify that the pull request reports \`merged\` and that the target branch moved. If checks fail, the pull request conflicts, or an approval is required, stop here and report it; do not retry the merge.`
      : '5. Do not merge the pull request: merging was not authorized. Do not run `gh pr merge`; report the merge as not authorized, then continue with the authorized steps below.',
    closeIssue
      ? issueNumber === undefined
        ? '6. Do not close the issue: this page carries no issue number, so closing it was not authorized. Report it as not authorized.'
        : `6. Close the issue: \`gh issue close ${issue} --comment "delivered in <sha> via PR #<number>"\`. If the pull request already closed it (a \`Closes ${issue}\` body), only verify that it is closed and do not write a second comment.`
      : `6. Do not close the issue${issueNumber === undefined ? '' : ` ${issue}`}: closing it was not authorized. Report it as not authorized.`,
    `7. Once every authorized step above has finished, mark this workspace completed: \`orca worktree set --worktree <self> --workspace-status completed --comment "${deliveredComment}"\` (adjust the comment to what actually happened). This is the only place delivery writes state.`,
    '',
    'Stop conditions: if any authorized step fails, stop at that step. Do not continue to a later write. Never use --force, never change branch protection, and never stash, reset, clean or delete the operator\'s work.',
    'Report finished / unfinished / not authorized as three separate sections, naming what already happened.',
    '',
    'Do not archive, remove, stop terminals or delete anything. A human clicks Archive as the last step, after your report.'
  ]
  if (archiveAfter) {
    lines.push(
      '',
      'The operator asked to archive this workspace after delivery. Do not archive it yourself; Orca archives it once it observes the completed status, and only reminds you here so the report does not claim it.'
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

/** The history shape the merge produces on the target branch. The integration
 *  mode names the shape, so it also names the flag; `pr` keeps the merge commit
 *  GitHub would create for a merge, which is the mode's own wording. */
function mergeFlag(integrationMode: TaskWorkbenchDeliverIntegrationMode): string {
  return integrationMode === 'squash' ? '--squash' : '--merge'
}

/**
 * Host-published launches in flight (§7.12 A5).
 *
 * Why a time window and not a stored fact: the host route writes its marker
 * asynchronously (the host RPC has to answer and the mirror has to arrive), so
 * for a short while the store legitimately has no marker tab. Without this
 * guard a second click in that window starts a second agent — the exact failure
 * §7.11.6 bound 2 described. Local and structured routes publish their tab
 * synchronously, so they clear the entry immediately; the window only covers the
 * host RPC's own 15s deadline plus the mirror.
 */
const HOST_LAUNCH_IN_FLIGHT_MS = 20_000
const inFlightHostLaunches = new Map<string, number>()

function isHostLaunchInFlight(worktreeId: string): boolean {
  const startedAt = inFlightHostLaunches.get(worktreeId)
  if (startedAt === undefined) {
    return false
  }
  if (Date.now() - startedAt > HOST_LAUNCH_IN_FLIGHT_MS) {
    inFlightHostLaunches.delete(worktreeId)
    return false
  }
  return true
}

/** Test-only reset: the window is module state. */
export function resetTaskWorkbenchDeliverInFlight(): void {
  inFlightHostLaunches.clear()
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
  if (
    findTaskWorkbenchDeliverTabId(input.worktreeId) !== null ||
    isHostLaunchInFlight(input.worktreeId)
  ) {
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
  // Local and structured routes published their marker synchronously; only the
  // host route needs the window (see the comment above).
  if (launched.surface.kind === 'host-published') {
    inFlightHostLaunches.set(input.worktreeId, Date.now())
  }
  if (input.archiveAfter) {
    // Why only after a real launch: a failed launch must not leave an intent
    // that would archive the workspace the next time it is seen completed.
    recordTaskWorkbenchArchiveIntent(input.worktreeId)
  }
  // A paired host owns the tab; this client has no local id to reveal.
  return {
    ok: true,
    tabId: launched.surface.kind === 'host-published' ? '' : launched.surface.tabId
  }
}
