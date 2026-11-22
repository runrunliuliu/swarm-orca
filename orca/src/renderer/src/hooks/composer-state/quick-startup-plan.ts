import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentDraftLaunchPlan, AgentStartupPlan } from '@/lib/tui-agent-startup'
import {
  planQuickCreateLaunchPrompt,
  type NewWorkspaceLaunchSelection
} from '@/lib/swarm-launch-prompt'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import {
  TUI_AGENT_CONFIG,
  agentSupportsSubmittedPrefill
} from '../../../../shared/tui-agent-config'

export type QuickComposerStartupInput = {
  agent: TuiAgent | null
  /** Single-agent prompt: the linked work item text this composer would send today. */
  prompt: string
  /** Single-agent draft prompt; null when the text is submitted rather than drafted. */
  draftPrompt: string | null | undefined
  /** Start mode chosen in the composer. Defaults to the single-agent behaviour. */
  launch?: NewWorkspaceLaunchSelection
  /** Swarm-only inputs: what the generated Coordinator prompt names. */
  linkedWorkItemUrl?: string | null
  repoPath?: string
  baseRef?: string | null
  note?: string
  settings: GlobalSettings | null | undefined
  repoConnectionId: string | null | undefined
  platform: NodeJS.Platform
  shell: AgentStartupShell | null | undefined
  isRemote: boolean
  telemetrySource: WorktreeCreationRequest['telemetrySource']
}

export type QuickComposerStartup = {
  startupPlan: AgentStartupPlan | null
  backendStartup: WorktreeCreationRequest['startup']
  /** Text the agent receives first, whichever route delivers it. */
  deliveredPrompt: string
  /** Value for `WorktreeCreationRequest.quickPrompt`: the single-agent command prompt, or the
   *  generated Coordinator brief. Deliberately not the draft — `launchDraftPrompt` carries that. */
  creationPrompt: string
  /** Unsent launch context for the chat mirror; null once the prompt is submitted. */
  launchDraftPrompt: string | null
  /** Decided once, beside the startup plan, and carried on the creation request. */
  promptDelivery: 'draft' | 'auto-submit' | 'submit-after-ready'
  telemetry: AgentStartedTelemetry | null
}

/** The startup-plan shape of a draft launch: same launch, but nothing for the post-create
 *  paste to deliver — the draft already travels in `env` or on the command line. */
function startupPlanFromDraftPlan(plan: AgentDraftLaunchPlan): AgentStartupPlan {
  return {
    agent: plan.agent,
    launchCommand: plan.launchCommand,
    expectedProcess: plan.expectedProcess,
    followupPrompt: null,
    launchConfig: plan.launchConfig,
    ...(plan.sessionOptions ? { sessionOptions: plan.sessionOptions } : {}),
    ...(plan.startupCommandDelivery ? { startupCommandDelivery: plan.startupCommandDelivery } : {}),
    ...(plan.env ? { env: plan.env } : {})
  }
}

export function buildQuickComposerStartup(input: QuickComposerStartupInput): QuickComposerStartup {
  const { agent, settings } = input
  const launchPrompt = planQuickCreateLaunchPrompt({
    selection: input.launch ?? { mode: 'single', maxWorkers: null },
    agentSelected: agent !== null,
    singleAgentPrompt: input.prompt,
    singleAgentDraftPrompt: input.draftPrompt ?? null,
    linkedWorkItemUrl: input.linkedWorkItemUrl ?? null,
    repoPath: input.repoPath ?? '',
    baseRef: input.baseRef ?? null,
    note: input.note ?? ''
  })
  const draftPrompt = launchPrompt.draftPrompt
  const pasteAfterReadyPrompt = launchPrompt.pasteAfterReadyPrompt
  const prompt = launchPrompt.commandPrompt
  const sessionOptions =
    agent === null
      ? undefined
      : resolveInitialNativeChatSessionOptions(
          {
            experimentalNativeChat: settings?.experimentalNativeChat,
            openAgentTabsInChatByDefault: settings?.openAgentTabsInChatByDefault,
            nativeChatSessionOptions: settings?.nativeChatSessionOptions
          },
          {
            agent,
            ...(draftPrompt
              ? { promptDelivery: 'draft' as const, launchDraftText: draftPrompt }
              : {}),
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              input.repoConnectionId
            )
          }
        )
  const buildDraftPlan = (draft: string, submitDraft = false): AgentDraftLaunchPlan | null =>
    agent === null
      ? null
      : buildAgentDraftLaunchPlan({
          agent,
          draft,
          submitDraft,
          cmdOverrides: settings?.agentCmdOverrides ?? {},
          agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
          agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
          sessionOptions,
          platform: input.platform,
          shell: input.shell ?? undefined,
          isRemote: input.isRemote
        })
  const draftLaunchPlan = !draftPrompt ? null : buildDraftPlan(draftPrompt)
  // Why: a submitted prompt has no argv slot. Agents whose prefill hook can start the turn
  // (pi) get it as an env seed instead, so delivery does not depend on paste-after-ready —
  // which #54 measured as not delivering at all. The paste branch stays as the fallback for
  // every other agent and for a launch the platform cannot carry inline.
  const submittedPrefillPlan =
    agent !== null &&
    pasteAfterReadyPrompt &&
    agentSupportsSubmittedPrefill(TUI_AGENT_CONFIG[agent])
      ? buildDraftPlan(pasteAfterReadyPrompt, true)
      : null
  let startupPlan: AgentStartupPlan | null = null
  if (submittedPrefillPlan) {
    // Why: no draftPrompt — the agent starts the turn itself, so there is nothing for the
    // post-create paste to deliver.
    startupPlan = startupPlanFromDraftPlan(submittedPrefillPlan)
  } else if (agent !== null && pasteAfterReadyPrompt) {
    // Why first: a paste-only prompt must not be folded into the launch command by either branch
    // below, and the plan still has to carry the text so the post-create delivery knows what to type.
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides: settings?.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
      sessionOptions,
      platform: input.platform,
      shell: input.shell ?? undefined,
      isRemote: input.isRemote,
      allowEmptyPromptLaunch: true
    })
    if (startupPlan) {
      startupPlan.draftPrompt = pasteAfterReadyPrompt
    }
  } else if (draftLaunchPlan) {
    startupPlan = startupPlanFromDraftPlan(draftLaunchPlan)
  } else if (agent !== null) {
    startupPlan = buildAgentStartupPlan({
      agent,
      prompt,
      cmdOverrides: settings?.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
      sessionOptions,
      platform: input.platform,
      shell: input.shell ?? undefined,
      isRemote: input.isRemote,
      allowEmptyPromptLaunch: true
    })
    if (startupPlan && draftPrompt) {
      startupPlan.draftPrompt = draftPrompt
    }
  }
  const telemetry: AgentStartedTelemetry | null =
    agent === null
      ? null
      : {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source:
            input.telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer',
          request_kind: 'new'
        }
  const backendStartup =
    startupPlan && !startupPlan.draftPrompt && !startupPlan.followupPrompt
      ? {
          command: startupPlan.launchCommand,
          ...(startupPlan.env ? { env: startupPlan.env } : {}),
          launchConfig: startupPlan.launchConfig,
          ...(agent ? { launchAgent: agent } : {}),
          ...(startupPlan.startupCommandDelivery
            ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
            : {}),
          ...(telemetry ? { telemetry } : {})
        }
      : undefined
  return {
    startupPlan,
    backendStartup,
    deliveredPrompt: launchPrompt.deliveredPrompt,
    creationPrompt: pasteAfterReadyPrompt ?? input.prompt,
    launchDraftPrompt: draftPrompt,
    // Why: a prefill-submit launch carries and submits the brief on its own, which is what
    // `auto-submit` already means for this request — the renderer has nothing left to paste.
    promptDelivery: submittedPrefillPlan ? ('auto-submit' as const) : launchPrompt.promptDelivery,
    telemetry
  }
}
