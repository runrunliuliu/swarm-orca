import type { TuiAgent } from '../../../shared/tui-agent'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '../lib/agent-launch-prompt-delivery'
import type { AgentPromptSubmissionVerdict } from '../lib/agent-prompt-submission'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { toWebTerminalSurfaceTabId } from './web-terminal-surface-id'
import type {
  CreateWebRuntimeSessionTerminalArgs,
  WebRuntimeTerminalCreateOutcome
} from './web-runtime-session-types'

export async function createWebRuntimeSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs
): Promise<WebRuntimeTerminalCreateOutcome> {
  return (await createWebRuntimeSessionTerminalResult(args)).outcome
}

export async function createWebRuntimeAgentSessionTerminal(
  args: CreateWebRuntimeSessionTerminalArgs & {
    agent: TuiAgent
    promptAfterReady: string
    submitPrompt: boolean
    forcePromptPaste: boolean
    /** The paste was written without ever observing the agent's composer. */
    onUnconfirmedDelivery?: () => void
    /** What this launch may claim about the instruction becoming a turn (issue #60). */
    onSubmitVerdict?: (verdict: AgentPromptSubmissionVerdict) => void
  }
): Promise<{
  outcome: WebRuntimeTerminalCreateOutcome
  promptDelivered: boolean
}> {
  const created = await createWebRuntimeSessionTerminalResult(args)
  if (created.outcome.status === 'failed' || !created.hostTabId) {
    return { outcome: created.outcome, promptDelivered: false }
  }

  const promptDelivered = await deliverLaunchPromptToAgentTab({
    tabId: toWebTerminalSurfaceTabId(created.hostTabId),
    content: args.promptAfterReady,
    agent: args.agent,
    submit: args.submitPrompt,
    forcePaste: args.forcePromptPaste,
    // Why forwarded on this route too: a paired host's mirrored pane is where the readiness wait
    // actually ran, so silence here (as it used to be) made an unobserved composer look delivered.
    ...(args.onUnconfirmedDelivery ? { onUnconfirmedDelivery: args.onUnconfirmedDelivery } : {}),
    ...(args.onSubmitVerdict ? { onSubmitVerdict: args.onSubmitVerdict } : {})
  })
  return { outcome: created.outcome, promptDelivered }
}

/**
 * Launch a web-host agent terminal whose draft already rode in on the launch
 * command (argv prefill). No post-ready paste runs for that delivery, so seed
 * the chat-composer copy here once the mirrored host tab id is known.
 */
export async function createWebRuntimeAgentSessionTerminalWithLaunchDraft(
  args: CreateWebRuntimeSessionTerminalArgs & {
    agent: TuiAgent
    launchDraft: string
  }
): Promise<WebRuntimeTerminalCreateOutcome> {
  const created = await createWebRuntimeSessionTerminalResult(args)
  if (created.outcome.status !== 'failed' && created.hostTabId) {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: toWebTerminalSurfaceTabId(created.hostTabId),
      agent: args.agent,
      text: args.launchDraft
    })
  }
  return created.outcome
}
