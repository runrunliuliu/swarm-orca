/**
 * Launching the draft's agent tab: one plan, one activation, one startup delivery.
 * Plain function (no React) so the dock hook and its retry path share it.
 */
import { getFolderWorkspaceAgentLaunchPlatform } from '@/components/sidebar/folder-workspace-agent-startup'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { joinPath } from '@/lib/path'
import { buildTaskDraftPrompt } from '@/lib/task-draft-prompt'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ActiveTaskDraft } from '@/lib/task-draft-create-flow'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

export async function launchDraftAgent(
  draft: ActiveTaskDraft,
  group: ProjectGroup,
  settings: GlobalSettings | null,
  text: string
): Promise<void> {
  const agent = resolveDefaultAgentForNewTab({
    defaultTuiAgent: settings?.defaultTuiAgent,
    detectedAgentIds: useAppStore.getState().detectedAgentIds,
    disabledTuiAgents: settings?.disabledTuiAgents
  })
  if (!agent) {
    throw new Error(
      translate(
        'auto.components.TaskPage.taskDockNoAgent',
        'No agent is enabled, so the draft was created without a session. Turn one on in Settings, then send again.'
      )
    )
  }
  const plan = buildDockAgentStartup({
    agent,
    prompt: buildTaskDraftPrompt({
      instruction: text,
      targetLabel: draft.target.label,
      draftKey: draft.draftKey,
      provider: draft.target.provider,
      repoId: draft.target.repoId ?? null,
      proposalPath: joinPath(draft.folderPath, 'task-draft-proposal.json')
    }),
    group,
    settings
  })
  if (!plan) {
    throw new Error(
      translate(
        'auto.components.TaskPage.taskDockAgentLaunchFailed',
        'The agent could not be launched in the draft workspace.'
      )
    )
  }
  // Why: activation and delayed delivery must share one launch token or the prompt misses the tab.
  plan.launchToken = createBrowserUuid()
  const activation = activateAndRevealFolderWorkspace(draft.folderWorkspaceId, {
    agent,
    startup: toStartupPayload(plan, agent)
  })
  if (activation === false) {
    throw new Error(
      translate(
        'auto.components.TaskPage.taskDockOpenFailed',
        'The draft workspace could not be opened.'
      )
    )
  }
  draft.primaryTabId = activation.primaryTabId
  draft.agent = agent
  void ensureAgentStartupInTerminal({
    worktreeId: folderWorkspaceKey(draft.folderWorkspaceId),
    primaryTabId: activation.primaryTabId,
    startup: plan
  })
}

/** One command line for the agent tab; the builder keeps every value a separate argv entry. */
export function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteCommandArg).join(' ')
}

function quoteCommandArg(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Re-run the launch into the draft's existing workspace (agent-launch-failed retry). */
export async function relaunchDraftAgent(active: ActiveTaskDraft): Promise<void> {
  const appState = useAppStore.getState()
  const group = appState.projectGroups.find((candidate) => candidate.id === active.target.projectId)
  if (!group) {
    throw new Error(
      translate(
        'auto.components.TaskPage.taskDockNoProjectGroup',
        'Pick a repository that belongs to a project group.'
      )
    )
  }
  await launchDraftAgent(active, group, appState.settings, active.instruction)
}

/**
 * A follow-up goes to the draft's running tab. `ensureAgentStartupInTerminal` is a
 * startup channel (argv plans no-op, stale tokens are dropped), so it cannot carry
 * a second instruction; this is the same running-tab primitive other launch paths use.
 */
export async function deliverToActiveDraft(
  draft: ActiveTaskDraft,
  instruction: string
): Promise<void> {
  if (!draft.primaryTabId || !draft.agent) {
    throw new Error(
      translate(
        'auto.components.TaskPage.taskDockNoSession',
        'This draft has no agent session. Open it from the sidebar and start an agent, then send again.'
      )
    )
  }
  const delivered = await deliverLaunchPromptToAgentTab({
    tabId: draft.primaryTabId,
    agent: draft.agent,
    content: instruction,
    submit: true,
    forcePaste: true
  }).catch(() => false)
  if (!delivered) {
    throw new Error(
      translate(
        'auto.components.TaskPage.taskDockInstructionNotDelivered',
        'The draft session did not accept the instruction.'
      )
    )
  }
}

function buildDockAgentStartup(args: {
  agent: TuiAgent
  prompt: string
  group: ProjectGroup
  settings: GlobalSettings | null
}): AgentStartupPlan | null {
  const platform = getFolderWorkspaceAgentLaunchPlatform(args.group)
  return buildAgentStartupPlan({
    agent: args.agent,
    prompt: args.prompt,
    cmdOverrides: args.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(args.agent, args.settings?.agentDefaultEnv),
    platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: args.settings?.terminalWindowsShell
    }),
    isRemote: false
  })
}

function toStartupPayload(plan: AgentStartupPlan, agent: TuiAgent): WorktreeStartupPayload {
  return {
    command: plan.launchCommand,
    ...(plan.env ? { env: plan.env } : {}),
    launchConfig: plan.launchConfig,
    ...(plan.launchToken ? { launchToken: plan.launchToken } : {}),
    launchAgent: agent,
    ...(plan.sessionOptions ? { sessionOptions: plan.sessionOptions } : {}),
    ...(plan.draftPrompt ? { draftPrompt: plan.draftPrompt } : {}),
    ...(plan.startupCommandDelivery
      ? { startupCommandDelivery: plan.startupCommandDelivery }
      : {})
  }
}
