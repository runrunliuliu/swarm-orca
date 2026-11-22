import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { pasteDraftToAgentPtyWhenReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'
import { reportAgentPromptDeliveryFailure } from '@/lib/agent-prompt-delivery-failure'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Deliver a generated prompt that must be submitted, not left editable — the
 * Swarm Coordinator start. Multi-line prompts cannot ride on the launch command
 * (`WorktreeStartupLaunch` has no argv slot for them), so the agent starts with
 * an empty input box and this paste is the only delivery attempt.
 *
 * A stalled readiness wait would therefore drop the whole brief, so the timeout
 * degrades to an unsubmitted paste: the text is in the box, the user presses
 * Enter. The second attempt is not wasteful — the delay that just expired is
 * extra startup time it gets to use.
 *
 * An unobserved Enter verdict is not a timeout: that paste already landed, so
 * it is kept and the user is asked for one keypress instead of pasting twice.
 */
export async function deliverSubmittedLaunchPromptWhenReady(args: {
  tabId: string
  ptyId: string
  agent: TuiAgent
  content: string
}): Promise<void> {
  try {
    await submitLaunchPromptInAgentComposer(args)
  } catch (error) {
    // Why: a rejected write (destroyed PTY, failed input RPC) previously escaped to nobody,
    // so a lost Coordinator brief produced no turn, no toast and no event (#54).
    console.warn('Coordinator prompt delivery failed', error)
    reportAgentPromptDeliveryFailure(args.agent)
  }
}

async function submitLaunchPromptInAgentComposer(args: {
  tabId: string
  ptyId: string
  agent: TuiAgent
  content: string
}): Promise<void> {
  let readinessTimedOut = false
  const submitted = await deliverLaunchPromptToAgentTab({
    tabId: args.tabId,
    agent: args.agent,
    content: args.content,
    submit: true,
    forcePaste: true,
    onTimeout: () => {
      readinessTimedOut = true
    }
  })
  if (submitted) {
    return
  }
  if (!readinessTimedOut) {
    // Why: the paste was issued but the Enter verdict was not observed. Pasting
    // again would duplicate the brief, so leave it for one keypress instead.
    toast.message(
      translate(
        'auto.lib.swarm.launch.prompt.delivery.e987796905',
        "Your Coordinator prompt is in the agent's input box — press Enter to start it."
      )
    )
    track('agent_error', {
      error_class: 'submit_not_verified',
      agent_kind: tuiAgentToAgentKind(args.agent)
    })
    return
  }
  const keptAsDraft = await pasteDraftToAgentPtyWhenReady({
    tabId: args.tabId,
    ptyId: args.ptyId,
    content: args.content,
    agent: args.agent,
    forcePaste: true,
    submit: false,
    onTimeout: () => showAutomationPromptNotSentToast(args.agent)
  })
  if (!keptAsDraft) {
    return
  }
  toast.message(
    translate(
      'auto.lib.swarm.launch.prompt.delivery.40c2ebd0e1',
      "The agent took too long to start. Your Coordinator prompt is in its input box, unsent — press Enter when it's ready."
    )
  )
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(args.agent)
  })
}
