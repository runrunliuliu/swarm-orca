import { useCallback, useMemo, useRef, useState } from 'react'
import type { TaskPageComposerActionsModel } from '@/components/use-task-page-composer-actions'
import type { TaskDockModel } from '@/components/task-page/TaskDock'
import { getTaskPageRepoSourceContext } from '@/components/task-page-source-context'
import { getFolderWorkspaceAgentLaunchPlatform } from '@/components/sidebar/folder-workspace-agent-startup'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { getTaskDraftName } from '@/lib/task-draft-name'
import { buildTaskDraftPrompt } from '@/lib/task-draft-prompt'
import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { activateAndRevealFolderWorkspace } from '@/lib/worktree-activation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskProvider } from '../../../shared/task-providers'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

type ActiveTaskDraft = {
  folderWorkspaceId: string
  primaryTabId: string | null
  draftKey: string
  /** The agent launched into the draft's tab; null until a launch succeeds. */
  agent: TuiAgent | null
}

export function useTaskPageDockActions(model: TaskPageComposerActionsModel) {
  const { taskSource, primaryRepo, folderWorkspaces } = model
  const [instruction, setInstruction] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Why: one key per draft, kept until the workspace exists so a retry reuses the same scratch directory.
  const draftKeyRef = useRef<string | null>(null)
  const activeDraftRef = useRef<ActiveTaskDraft | null>(null)

  const targetLabel = useMemo(
    () => (primaryRepo ? getDockTargetLabel(primaryRepo, taskSource) : null),
    [primaryRepo, taskSource]
  )

  const submit = useCallback(async (): Promise<void> => {
    const text = instruction.trim()
    if (!text || submitting) {
      return
    }
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const active = activeDraftRef.current
      if (active) {
        await deliverToActiveDraft(active, text)
        setInstruction('')
        setExpanded(false)
        return
      }
      const state = useAppStore.getState()
      const repo = primaryRepo
      if (!repo) {
        throw new Error(
          translate(
            'auto.components.TaskPage.taskDockPickTarget',
            'Pick a source and a repository first.'
          )
        )
      }
      const group = state.projectGroups.find((candidate) => candidate.id === repo.projectGroupId)
      if (!group) {
        throw new Error(
          translate(
            'auto.components.TaskPage.taskDockNoProjectGroup',
            'Pick a repository that belongs to a project group.'
          )
        )
      }
      // Why: the scratch directory is app-owned and local; a remote group has no path this host can create.
      if (group.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
        throw new Error(
          translate(
            'auto.components.TaskPage.taskDockLocalRepoRequired',
            'Drafts need a local repository.'
          )
        )
      }
      const draftKey = draftKeyRef.current ?? createBrowserUuid()
      draftKeyRef.current = draftKey
      const folderPath = await window.api.app.getTaskDraftDirectory({ draftKey })
      const name = getTaskDraftName({
        instruction: text,
        provider: taskSource,
        existingNames: folderWorkspaces.map((workspace) => workspace.name)
      }).displayName
      const workspace = await state.createFolderWorkspace(
        { projectGroupId: group.id, name, folderPath, taskDraft: true },
        // Why: a draft must land on this host even when the focused runtime is an environment.
        { runtimeEnvironmentId: null }
      )
      if (!workspace) {
        throw new Error(
          translate(
            'auto.components.TaskPage.taskDockCreateWorkspaceFailed',
            'Could not create the draft workspace.'
          )
        )
      }
      // Why: remembered before the launch so a failed launch never creates a second draft row.
      const draft: ActiveTaskDraft = {
        folderWorkspaceId: workspace.id,
        primaryTabId: null,
        draftKey,
        agent: null
      }
      activeDraftRef.current = draft
      const agent = resolveDefaultAgentForNewTab({
        defaultTuiAgent: state.settings?.defaultTuiAgent,
        detectedAgentIds: state.detectedAgentIds,
        disabledTuiAgents: state.settings?.disabledTuiAgents
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
          targetLabel: getDockTargetLabel(repo, taskSource)
        }),
        group,
        settings: state.settings
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
      const activation = activateAndRevealFolderWorkspace(workspace.id, {
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
        worktreeId: folderWorkspaceKey(workspace.id),
        primaryTabId: activation.primaryTabId,
        startup: plan
      })
      setInstruction('')
      setExpanded(false)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }, [instruction, submitting, primaryRepo, taskSource, folderWorkspaces])

  const taskDock: TaskDockModel = {
    instruction,
    expanded,
    targetLabel,
    submitting,
    errorMessage,
    onInstructionChange: setInstruction,
    onExpandedChange: setExpanded,
    onSubmit: () => {
      void submit()
    }
  }
  return Object.assign(model, { taskDock })
}

export type TaskPageDockActionsModel = ReturnType<typeof useTaskPageDockActions>

/** `provider · owner/repo` for the dock chip; falls back to the repo's display name. */
function getDockTargetLabel(repo: Repo, provider: TaskProvider): string {
  const identity = getTaskPageRepoSourceContext(repo, 'github')?.providerIdentity
  const repoLabel =
    identity?.provider === 'github' ? `${identity.owner}/${identity.repo}` : repo.displayName
  return `${provider} · ${repoLabel}`
}

/**
 * A follow-up goes to the draft's running tab. `ensureAgentStartupInTerminal` is a
 * startup channel (argv plans no-op, stale tokens are dropped), so it cannot carry
 * a second instruction; this is the same running-tab primitive other launch paths use.
 */
async function deliverToActiveDraft(draft: ActiveTaskDraft, instruction: string): Promise<void> {
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
    ...(plan.startupCommandDelivery ? { startupCommandDelivery: plan.startupCommandDelivery } : {})
  }
}
