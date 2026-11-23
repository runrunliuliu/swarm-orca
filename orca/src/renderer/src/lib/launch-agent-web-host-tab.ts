import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  createWebRuntimeSessionTerminal,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentPromptDelivery } from '../../../shared/agent-session-host-authority'
import { translate } from '@/i18n/i18n'
import { replaceWorktreeSelectorNotFoundCode } from '@/lib/worktree-selector-not-found-notice'
import { toAgentLaunchPreferences } from '../../../shared/agent-launch-preferences'
import type { AgentPromptSubmissionVerdict } from '@/lib/agent-prompt-submission'

function removeStaleLocalAgentTabsForWebHostLaunch(worktreeId: string): void {
  const state = useAppStore.getState()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (tab.launchAgent && !isWebTerminalSurfaceTabId(tab.id)) {
      // Why: pruning a stale local agent tab is a system close — keep it out of
      // the Cmd+Shift+T reopen stack.
      state.closeTab(tab.id, { reason: 'cleanup' })
    }
  }
}

/**
 * Launch an agent terminal on the web runtime host instead of a local tab.
 *
 * Why: paired web tabs are host-owned, so this path never creates a local tab
 * (callers return tabId: null). Local-only agent tabs cannot be closed because
 * close routes through session.tabs.close on the host, so prune them before
 * the host snapshot.
 */
export function launchAgentInWebHostTab(args: {
  agent: TuiAgent
  worktreeId: string
  environmentId: string | null
  groupId?: string
  cwd?: string | null
  startupPlan: AgentStartupPlan
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  pastePromptAfterReady: string | null
  submitPastedPrompt: boolean
  agentArgs?: string | null
  /**
   * The complete command already encodes this launch, so the host must run it as it stands.
   *
   * Why it is not just an optimisation: a client whose Settings replaced this agent's command
   * wrote its arguments for *that* command (`sh -c 'exec traecli "$@"' wrapper-dispatch`). Sending
   * only the arguments lets the host append them to its own executable, which turned the wrapper's
   * marker into Trae's first prompt (issue #60). When this is set the command travels instead of
   * the arguments, and the create operation takes the legacy path for exactly that reason.
   */
  preparedAgentCommand?: boolean
  spawnedFromPaneKey?: string
  viewMode?: Tab['viewMode']
  /** Marks the mirrored local tab so a second delivery click reveals it instead
   *  of starting another agent (§7.11.6 bound 2, §7.12 S5). */
  quickCommandLabel?: string | null
  onPromptDelivered?: () => void
  /** The paste was written without ever observing the agent's composer. */
  onPromptDeliveryUnconfirmed?: () => void
  /** What this launch may claim about the instruction becoming a turn (issue #60). */
  onPromptSubmitVerdict?: (verdict: AgentPromptSubmissionVerdict) => void
}): Promise<{ delivered: boolean; failureNotified: boolean }> {
  const {
    agent,
    worktreeId,
    environmentId,
    groupId,
    cwd,
    startupPlan,
    prompt,
    promptDelivery,
    pastePromptAfterReady,
    submitPastedPrompt,
    agentArgs,
    preparedAgentCommand = false,
    spawnedFromPaneKey,
    viewMode,
    quickCommandLabel,
    onPromptDelivered,
    onPromptDeliveryUnconfirmed,
    onPromptSubmitVerdict
  } = args
  const hasPrompt = prompt.length > 0
  const launchPreferences = toAgentLaunchPreferences(startupPlan.sessionOptions)
  const structuredPromptDelivery: AgentPromptDelivery =
    promptDelivery === 'draft' ? 'draft' : 'auto-submit'
  removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
  // Why two shapes instead of one: the wire answers "who owns the command line". A prepared launch
  // sends the whole command with its arguments inside it and never `agentArgs`; a host-owned launch
  // sends the agent (plus transportable arguments) and lets the host build the command from its own
  // Settings. Mixing the halves is issue #60.
  const launch = {
    worktreeId,
    environmentId,
    targetGroupId: groupId,
    activate: true,
    ...(cwd?.trim() ? { cwd } : {}),
    ...(viewMode ? { viewMode } : {}),
    agentSessionKind: 'fresh',
    ...(preparedAgentCommand
      ? {
          launchAgent: agent,
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          preparedAgentCommand: true
        }
      : {
          ...(hasPrompt
            ? {
                launchAgent: agent,
                // Why still sent: an older host without host authority runs this command itself, and
                // it is the only thing carrying the prompt on that path.
                command: startupPlan.launchCommand,
                ...(startupPlan.env ? { env: startupPlan.env } : {}),
                launchConfig: startupPlan.launchConfig,
                ...(startupPlan.startupCommandDelivery
                  ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
                  : {})
              }
            : { agent }),
          ...(hasPrompt && pastePromptAfterReady === null ? { prompt } : {}),
          ...(hasPrompt && pastePromptAfterReady === null
            ? { promptDelivery: structuredPromptDelivery }
            : {}),
          ...(agentArgs !== undefined ? { agentArgs } : {})
        }),
    ...(spawnedFromPaneKey ? { spawnedFromPaneKey } : {}),
    ...(launchPreferences ? { launchPreferences } : {}),
    ...(quickCommandLabel ? { quickCommandLabel } : {})
  } as const

  const handleCreation = ({
    outcome,
    promptDelivered
  }: {
    outcome: Awaited<ReturnType<typeof createWebRuntimeSessionTerminal>>
    promptDelivered: boolean
  }): { delivered: boolean; failureNotified: boolean } => {
    // Why: created means the host accepted the launch, not that a local tab
    // exists; keep pruning stale local rows until the snapshot mirrors.
    removeStaleLocalAgentTabsForWebHostLaunch(worktreeId)
    if (outcome.status === 'failed') {
      toast.error(
        replaceWorktreeSelectorNotFoundCode(
          outcome.message ||
            translate(
              'auto.lib.launch.agent.in.new.tab.11cce5cc77',
              'Could not launch {{value0}} in a new terminal.',
              { value0: agent }
            )
        )
      )
      return { delivered: false, failureNotified: true }
    }
    useAppStore.getState().setActiveTabType('terminal', worktreeId)
    if (hasPrompt && promptDelivered) {
      onPromptDelivered?.()
    }
    return { delivered: promptDelivered, failureNotified: false }
  }

  if (pastePromptAfterReady !== null) {
    return createWebRuntimeAgentSessionTerminal({
      ...launch,
      agent,
      promptAfterReady: pastePromptAfterReady,
      submitPrompt: submitPastedPrompt,
      forcePromptPaste: true,
      ...(onPromptDeliveryUnconfirmed ? { onUnconfirmedDelivery: onPromptDeliveryUnconfirmed } : {}),
      ...(onPromptSubmitVerdict ? { onSubmitVerdict: onPromptSubmitVerdict } : {})
    }).then(handleCreation)
  }
  if (hasPrompt && promptDelivery === 'draft') {
    // Why: the draft rode in on the launch command, so no paste runs and
    // nothing else seeds the chat-composer copy for this host class.
    return createWebRuntimeAgentSessionTerminalWithLaunchDraft({
      ...launch,
      agent,
      launchDraft: prompt
    }).then((outcome) => handleCreation({ outcome, promptDelivered: outcome.status === 'created' }))
  }
  return createWebRuntimeSessionTerminal(launch).then((outcome) =>
    handleCreation({ outcome, promptDelivered: outcome.status === 'created' && hasPrompt })
  )
}
