import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { deliverLaunchPromptToAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { pasteDraftToAgentPtyWhenReady } from '@/lib/agent-paste-draft'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'
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
 */
export async function deliverSubmittedLaunchPromptWhenReady(args: {
  tabId: string
  ptyId: string
  agent: TuiAgent
  content: string
}): Promise<void> {
  const submitted = await deliverLaunchPromptToAgentTab({
    tabId: args.tabId,
    agent: args.agent,
    content: args.content,
    submit: true,
    forcePaste: true
  })
  if (submitted) {
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
      'auto.lib.swarm.launch.prompt.delivery.3ad61f7c0e',
      "The agent took too long to start. Your Coordinator prompt is in its input box, unsent — press Enter when it's ready."
    )
  )
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(args.agent)
  })
}
