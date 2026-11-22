import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Report a launch prompt that could not be written into the agent's terminal.
 *
 * Why this exists: the write/rejection used to escape to nobody — the queue only
 * `console.warn`ed and the create flow left the promise unobserved — so a dropped
 * Coordinator brief looked exactly like "the agent is just thinking" (#54). One
 * helper keeps every catch site on the same toast and the same telemetry class.
 */
export function reportAgentPromptDeliveryFailure(agent: TuiAgent | null | undefined): void {
  toast.message(
    translate(
      'auto.lib.agent.prompt.delivery.failure.d723fb5c38',
      "Orca couldn't hand the first prompt to the agent — open the workspace and paste it in."
    )
  )
  track('agent_error', {
    error_class: 'delivery_write_failed',
    agent_kind: agent ? tuiAgentToAgentKind(agent) : 'other'
  })
}
