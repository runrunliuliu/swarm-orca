import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { buildTaskDraftPrompt } from '@/lib/task-draft-prompt'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getFolderWorkspaceAgentLaunchPlatform } from '@/components/sidebar/folder-workspace-agent-startup'
import type { ActiveTaskDraft } from '@/hooks/use-task-page-dock-actions'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

/**
 * Start the draft's agent with the user's instruction. The model is the one selected in the dock;
 * it is appended as the agent's own `--model` argument, because that is the only model channel the
 * TUI launch has (the provider decides whether it accepts it).
 */
export async function launchDraftAgent(args: {
  draft: ActiveTaskDraft
  group: ProjectGroup
  settings: GlobalSettings | null
  instruction: string
  model: string
  targetLabel: string | null
}): Promise<void> {
  const { draft, group, settings, instruction, model } = args
  const agent = resolveDefaultAgentForNewTab({
    defaultTuiAgent: settings?.defaultTuiAgent,
    detectedAgentIds: useAppStore.getState().detectedAgentIds,
    disabledTuiAgents: settings?.disabledTuiAgents
  })
  if (!agent) {
    throw new Error(
      translate(
        'auto.components.TaskPage.taskDockNoAgent',
        'No agent is enabled. Turn one on in Settings, then send again.'
      )
    )
  }
  const plan = buildDockAgentStartup({
    agent,
    prompt: buildTaskDraftPrompt({ instruction, targetLabel: args.targetLabel }),
    group,
    settings,
    model
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

/**
 * A follow-up goes to the draft's running tab. `ensureAgentStartupInTerminal` is a startup channel
 * (argv plans no-op, stale tokens are dropped), so it cannot carry a second instruction.
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
  model: string
}): AgentStartupPlan | null {
  const platform = getFolderWorkspaceAgentLaunchPlatform(args.group)
  return buildAgentStartupPlan({
    agent: args.agent,
    prompt: args.prompt,
    cmdOverrides: args.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs),
    // Why the session-option channel and not an appended `--model`: the shared launch code strips a
    // configured model flag first, keeps `--` terminators intact, and reports a command override that
    // conflicts with the request. Appending by hand would duplicate `--model`, or land after `--`.
    ...(args.model.trim() ? { sessionOptions: { model: args.model.trim() } } : {}),
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
