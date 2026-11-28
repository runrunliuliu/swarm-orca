import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import {
  planLinkedIssueContextLaunch,
  resolveLinkedIssueContextDraft
} from '@/lib/linked-issue-context-draft'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import type { AgentPasteFailureReason } from '@/lib/agent-paste-draft'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { launchAgentInStructuredNewTab } from '@/lib/launch-agent-in-new-tab-structured'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  agentLaunchNeedsPreparedCommand,
  resolveAgentLaunchCommandOwnership
} from '../../../shared/agent-launch-command-ownership'
import type { AgentPromptSubmissionVerdict } from '@/lib/agent-prompt-submission'
import {
  planAgentSessionLaunch,
  withAgentSessionLaunchPrompt,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
  initialCwd?: string | null
  /** How to deliver the prompt: `draft` leaves it editable, `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar quick-launch entry point. */
  launchSource?: LaunchSource
  /** Explicit parent pane for user-initiated agent lineage. Omit for shortcut/CLI/external launches. */
  spawnedFromPaneKey?: string
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Shell platform for the startup command; defaults to renderer OS. SSH/WSL worktrees run Linux even from Windows. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
  /**
   * Called before `onPromptDelivered` when the paste was written without ever observing the
   * agent's composer, so the launch cannot claim the prompt arrived. Fires only on the
   * terminal route, whose readiness signal the client watches itself.
   */
  onPromptDeliveryUnconfirmed?: () => void
  /**
   * What this launch may claim once the prompt and its Enter were written out (issue #60).
   *
   * Why separate from `onPromptDelivered`: that reports the write. `submitted` is only said when
   * the agent published a turn that began after the write; `unconfirmed` is the honest answer for
   * a blind write, a between-turns agent that stayed between turns, or an agent that was already
   * running a turn the write cannot be attributed to.
   */
  onPromptSubmitVerdict?: (verdict: AgentPromptSubmissionVerdict) => void
  /** Keeps a preflighted route authoritative across workspace creation. */
  agentSessionLaunchPlan?: AgentSessionLaunchPlan
  /** The launch seeds a workspace being opened, so its PTY spawn must not reshuffle Recent. */
  pendingActivationSpawn?: boolean
  /** Lets a workspace reveal itself before the selected surface opens. */
  beforeSurfaceOpen?: (
    surface:
      | { kind: 'local-terminal' }
      | { kind: 'local-agent-session'; sessionId: string }
      | { kind: 'host-published' }
  ) => boolean | void
}

export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'local-agent-session'; tabId: string; sessionId: string }
  | { kind: 'host-published' }

export type LaunchAgentInNewTabResult = {
  surface: AgentLaunchSurface
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{
    delivered: boolean
    failureNotified: boolean
    failureReason?: AgentPasteFailureReason
    routeUnreported?: boolean
  }>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.surface.kind === 'host-published'
}

/**
 * Create a new terminal tab and queue the agent's launch command, optionally
 * with an initial prompt.
 *
 * Submission mode follows `promptInjectionMode`: argv/flag agents fold the
 * prompt into the launch command; followup-path agents launch empty and get a
 * post-ready draft paste. Callers can override via `promptDelivery`.
 *
 * Returns `null` when no startup plan can be built (e.g. a whitespace-only prompt).
 */
function launchAgentInNewTabInternal(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const {
    agent,
    worktreeId,
    groupId,
    prompt,
    agentArgs,
    initialCwd,
    promptDelivery: requestedPromptDelivery = 'auto-submit',
    launchSource,
    spawnedFromPaneKey,
    quickCommandLabel,
    launchPlatform,
    onPromptDelivered,
    onPromptDeliveryUnconfirmed,
    onPromptSubmitVerdict,
    agentSessionLaunchPlan,
    pendingActivationSpawn,
    beforeSurfaceOpen
  } = args
  const store = useAppStore.getState()
  const { worktreeSshConnectionId, resolvedLaunchPlatform, isRemote, queuedShell } =
    resolveAgentLaunchExecutionContext(store, {
      worktreeId,
      ...(launchPlatform ? { launchPlatform } : {})
    })
  const cmdOverrides = store.settings?.agentCmdOverrides ?? {}
  // Why the ownership question is answered here and not at send time: this is where the launch plan
  // is built from this client's Settings, so this is the only place that knows whether the plan's
  // command was this client's executable choice (issue #60).
  const launchCommandOwnership = resolveAgentLaunchCommandOwnership({ agent, cmdOverrides })
  const effectiveAgentArgs =
    agentArgs !== undefined
      ? agentArgs
      : resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs)
  const agentEnv = resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv)
  // Why here: every "new agent in an existing worktree" entry point (sidebar spawn, tab-bar quick
  // launch, canvas) funnels through this function, so one decision covers them all. The cached
  // issue block only fills a launch that would otherwise start with no prompt at all.
  const linkedIssuePlan = planLinkedIssueContextLaunch({
    prompt,
    promptDelivery: requestedPromptDelivery,
    // Why only without a prompt: a user prompt wins untouched, so building the block for it would
    // be wasted work on the hottest launch path.
    draft: prompt?.trim()
      ? null
      : resolveLinkedIssueContextDraft({
          // Why `?? {}`: the launch funnel also runs against partial store shapes (harnesses and
          // previews); an absent catalog means "no cached issue", not a crash on the launch path.
          worktree: findWorktreeById(store.worktreesByRepo ?? {}, worktreeId),
          settings: store.settings
        })
  })
  const trimmedPrompt = linkedIssuePlan.prompt.trim()
  // Why: every later delivery decision must see the injected draft as a draft, not as the
  // caller's requested delivery, or the block would be auto-submitted.
  const promptDelivery = linkedIssuePlan.promptDelivery
  const hasPrompt = trimmedPrompt.length > 0
  const isFollowupPath = TUI_AGENT_CONFIG[agent].promptInjectionMode === 'stdin-after-start'
  const workspaceKind = workspaceKindForWorktreeId(worktreeId)
  // Why: the remote host can't infer this client's draft/default view choice, so decide it here for paired tabs too.
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const initialViewModeOptions = {
    agent,
    promptDelivery: viewModePromptDelivery,
    launchDraftText: trimmedPrompt,
    nativeChatTranscriptIsLocalReadable:
      isNativeChatTranscriptLocalReadable(worktreeSshConnectionId)
  }
  const initialViewModeProps = initialAgentTabViewModeProps(store.settings, initialViewModeOptions)
  const startupPlanBase = {
    agent,
    cmdOverrides,
    platform: resolvedLaunchPlatform,
    shell: queuedShell,
    isRemote,
    agentArgs: effectiveAgentArgs,
    agentEnv,
    sessionOptions: resolveInitialNativeChatSessionOptions(store.settings, initialViewModeOptions)
  }
  const { startupPlan, pasteDraftAfterLaunch, submitPastedPrompt } = planLaunchAgentStartupPrompt({
    base: startupPlanBase,
    prompt: trimmedPrompt,
    promptDelivery,
    isFollowupPath,
    // Why never argv for the injected block: the block can reach the 12000-char budget and argv
    // prefill would put it on the launch command line. Launch clean and paste it after readiness.
    pasteOnlyPrompt: linkedIssuePlan.injectedIssueContext
  })
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (!startupPlan) {
    return null
  }

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    if (beforeSurfaceOpen?.({ kind: 'host-published' }) === false) {
      return null
    }
    const webHostDelivery = launchAgentInWebHostTab({
      agent,
      worktreeId,
      environmentId: runtimeEnvironmentId,
      groupId,
      cwd: initialCwd,
      startupPlan,
      prompt: trimmedPrompt,
      promptDelivery,
      pastePromptAfterReady: pasteDraftAfterLaunch,
      submitPastedPrompt,
      agentArgs,
      preparedAgentCommand: agentLaunchNeedsPreparedCommand(launchCommandOwnership),
      spawnedFromPaneKey,
      // Why: omission means terminal locally, but would let a paired host apply
      // its own default; send the client's resolved terminal choice explicitly.
      viewMode: initialViewModeProps.viewMode ?? 'terminal',
      ...(quickCommandLabel ? { quickCommandLabel } : {}),
      onPromptDelivered,
      ...(onPromptDeliveryUnconfirmed ? { onPromptDeliveryUnconfirmed } : {}),
      ...(onPromptSubmitVerdict ? { onPromptSubmitVerdict } : {})
    })
    return {
      surface: { kind: 'host-published' },
      startupPlan,
      pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
      ...(pasteDraftAfterLaunch !== null && promptDelivery === 'submit-after-ready'
        ? { promptDeliveryResult: webHostDelivery }
        : {})
    }
  }

  // Why the injected draft re-adopts a precomputed plan: a caller (empty-workspace default chat)
  // plans the route before this function sees the prompt, and the plan's begin/launch close over
  // that empty verdict — reusing it as-is would silently drop the issue block on the structured
  // route. Re-adoption keeps the decided route and changes only what it delivers.
  const plan = agentSessionLaunchPlan
    ? linkedIssuePlan.injectedIssueContext
      ? withAgentSessionLaunchPrompt(agentSessionLaunchPlan, {
          prompt: trimmedPrompt,
          promptDelivery: viewModePromptDelivery
        })
      : agentSessionLaunchPlan
    : planAgentSessionLaunch(store, {
        agent,
        workspace: { kind: workspaceKind, worktreeId },
        prompt: trimmedPrompt,
        promptDelivery: viewModePromptDelivery,
        tuiCustomization: { cwd: initialCwd },
        initialSessionOptions: startupPlan.sessionOptions,
        onPromptDelivered
      })
  if (plan?.route === 'structured-native-chat' && spawnedFromPaneKey) {
    // Why: this snapshot's structured launch/settlement contract cannot persist a provenance pin, and
    // falling through would silently downgrade the launch to a legacy terminal tab and lose structured
    // session/recovery behavior. The sidebar hides this affordance for structured-capable agents, so
    // reaching here is a caller bug: fail loudly instead of degrading the user's session.
    throw new Error(
      'spawnedFromPaneKey is not supported on the structured-native-chat launch route' +
        (plan ? '' : ': missing plan')
    )
  }
  if (plan?.route === 'structured-native-chat') {
    const structured = launchAgentInStructuredNewTab({
      plan,
      ...(beforeSurfaceOpen
        ? {
            beforeOpen: (sessionId: string) =>
              beforeSurfaceOpen({ kind: 'local-agent-session', sessionId })
          }
        : {}),
      ...(groupId ? { targetGroupId: groupId } : {}),
      ...(quickCommandLabel ? { quickCommandLabel } : {})
    })
    if (!structured) {
      return null
    }
    return {
      surface: {
        kind: 'local-agent-session',
        tabId: structured.tabId,
        sessionId: structured.sessionId
      },
      startupPlan,
      pasteDraftAfterLaunch: false,
      structuredSettlement: structured.structuredSettlement,
      ...(structured.promptDeliveryResult
        ? { promptDeliveryResult: structured.promptDeliveryResult }
        : {})
    }
  }

  if (beforeSurfaceOpen?.({ kind: 'local-terminal' }) === false) {
    return null
  }
  // Why: queue startup BEFORE TerminalPane mounts — it snapshots pendingStartupByTabId in useState on first render.
  // Why: followup path pastes an unsubmitted draft, so gate the initial chat view like a draft launch, not auto-submit.
  const tab = store.createTab(worktreeId, groupId, undefined, {
    launchAgent: agent,
    ...(spawnedFromPaneKey ? { spawnedFromPaneKey } : {}),
    quickCommandLabel,
    ...(pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...initialViewModeProps
  })
  seedNativeChatAppliedSessionOptions(tab.id, agent, startupPlan.sessionOptions)
  if (initialCwd?.trim()) {
    // Why: queue before mount so local, WSL, and SSH continuations preserve their subdirectory.
    store.queueTabInitialCwd(tab.id, initialCwd)
  }
  store.queueTabStartupCommand(tab.id, {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    ...(agentArgs !== undefined ? { agentArgsOverride: agentArgs } : {}),
    ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    ...(agent === 'command-code' && hasPrompt && promptDelivery === 'auto-submit'
      ? { initialAgentStatus: { agent, prompt: trimmedPrompt } }
      : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: launchSource ?? 'tab_bar_quick_launch',
      request_kind: 'new'
    }
  })
  // Why: fire-and-forget the paste-after-ready delivery so callers keep the synchronous { tabId, startupPlan } signature.
  // Why: safe to call unconditionally — the helper short-circuits (no paste) for native-prefill agents already holding the draft.
  if (hasPrompt && promptDelivery === 'draft' && pasteDraftAfterLaunch === null) {
    // Why: the draft rode in on argv (Claude --prefill etc.), so no paste runs
    // and deliverLaunchPromptToAgentTab never seeds. Mirror it into chat here.
    seedNativeChatLaunchDraftForAgentTab({ tabId: tab.id, agent, text: trimmedPrompt })
  }
  if (pasteDraftAfterLaunch !== null) {
    let failureReason: AgentPasteFailureReason | undefined
    const timeoutNotice = createPasteReadinessTimeoutNotice({
      worktreeId,
      tabId: tab.id,
      agent,
      submitted: submitPastedPrompt,
      // Why the text: the notice is sometimes the only surface the reader sees, and a prompt they
      // cannot copy is a delivery they have to retype (#60).
      prompt: pasteDraftAfterLaunch
    })
    const deliveryPromise = deliverLaunchPromptToAgentTab({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: submitPastedPrompt,
      forcePaste: true,
      onTimeout: (failure) => {
        failureReason = failure
        timeoutNotice.onTimeout(failure)
      },
      ...(onPromptDeliveryUnconfirmed ? { onUnconfirmedDelivery: onPromptDeliveryUnconfirmed } : {}),
      ...(onPromptSubmitVerdict ? { onSubmitVerdict: onPromptSubmitVerdict } : {})
    }).then((delivered) => {
      if (delivered) {
        if (agent === 'command-code' && submitPastedPrompt) {
          // Why: Command Code has no prompt-submit hook; when Orca submits a
          // generated prompt after readiness, seed working at delivery time.
          seedCommandCodeSubmittedPromptStatus(worktreeId, tab.id, trimmedPrompt)
        }
        onPromptDelivered?.()
      }
      return {
        delivered,
        failureNotified: !delivered && timeoutNotice.wasNotified(),
        ...(!delivered && failureReason ? { failureReason } : {}),
        ...(!delivered && timeoutNotice.wasUnreported() ? { routeUnreported: true } : {})
      }
    })
    if (promptDelivery === 'submit-after-ready') {
      promptDeliveryResult = deliveryPromise
    } else {
      void deliveryPromise.catch((error) =>
        console.error('Prompt delivery failed after launch', error)
      )
    }
  } else if (hasPrompt) {
    onPromptDelivered?.()
  }

  // Why: without setActiveTabType('terminal') an activated launch can stay hidden behind an editor.
  // Scoped to the launch's worktree so a floating or background launch leaves the main window's tab alone.
  store.setActiveTabType('terminal', worktreeId)

  // Why: persist tab-bar order so reconcileTabOrder doesn't fall back to terminals-first and jump the new tab to index 0.
  persistAgentLaunchTabOrder(worktreeId, tab.id)

  return {
    surface: { kind: 'local-terminal', tabId: tab.id },
    startupPlan,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  }
}

export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  return launchAgentInNewTabInternal(args)
}
