import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import { copyPromptToastAction } from '@/lib/copy-prompt-toast-action'
import {
  describeAgentPromptDeliveryFailure,
  type AgentPromptDeliveryFailureReason
} from '@/lib/launch-agent-paste-timeout-notice'

type LaunchAgentSessionContinuationArgs = {
  agent: TuiAgent
  prompt: string
  worktreeId: string
  groupId?: string | null
  initialCwd?: string | null
  launchSource: LaunchSource
}

export async function detectAgentSessionContinuationAgents(
  worktreeId: string
): Promise<TuiAgent[]> {
  const state = useAppStore.getState()
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return connectionId
    ? state.ensureRemoteDetectedAgents(connectionId)
    : runtimeEnvironmentId
      ? state.ensureRuntimeDetectedAgents(runtimeEnvironmentId)
      : state.ensureDetectedAgents(worktreeId)
}

async function ensureAgentAvailable(agent: TuiAgent, worktreeId: string): Promise<boolean> {
  const state = useAppStore.getState()
  const label = getAgentLabel(agent)
  if (!isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    toast.error(
      translate(
        'components.agentSessionContinuation.agentDisabled',
        '{{agent}} is disabled in Agent settings.',
        { agent: label }
      )
    )
    return false
  }

  let detectedAgents: TuiAgent[]
  try {
    detectedAgents = await detectAgentSessionContinuationAgents(worktreeId)
  } catch (error) {
    console.error('Agent detection failed for session continuation', error)
    detectedAgents = []
  }
  if (detectedAgents.includes(agent)) {
    return true
  }

  toast.error(
    translate(
      'components.agentSessionContinuation.agentUnavailable',
      '{{agent}} was not detected on this workspace host.',
      { agent: label }
    )
  )
  return false
}

export async function launchAgentSessionContinuation({
  agent,
  prompt,
  worktreeId,
  groupId,
  initialCwd,
  launchSource
}: LaunchAgentSessionContinuationArgs): Promise<boolean> {
  if (!(await ensureAgentAvailable(agent, worktreeId))) {
    return false
  }

  const label = getAgentLabel(agent)
  // Why: the paste helper writes blind when the agent's composer was never observed, so a
  // written prompt is not a delivered one. Claiming success there is how the whole handoff
  // could vanish silently (#22479).
  let deliveryUnconfirmed = false
  const result = launchAgentInNewTab({
    agent,
    worktreeId,
    ...(groupId ? { groupId } : {}),
    prompt,
    promptDelivery: agent === 'claude' ? 'draft' : 'submit-after-ready',
    launchSource,
    ...(initialCwd ? { initialCwd } : {}),
    onPromptDeliveryUnconfirmed: () => {
      deliveryUnconfirmed = true
    },
    onPromptDelivered: () => {
      if (deliveryUnconfirmed) {
        notifyDeliveryUnconfirmed(label, prompt)
        return
      }
      toast.success(
        translate(
          'components.agentSessionContinuation.sent',
          'Session context sent to {{agent}} in a new session.',
          { agent: label }
        )
      )
    }
  })
  if (!result) {
    notifyLaunchFailed(label)
    return false
  }

  if (result.promptDeliveryResult) {
    void result.promptDeliveryResult
      .then((delivery) => {
        if (!delivery.delivered && !delivery.failureNotified) {
          const reason: AgentPromptDeliveryFailureReason = delivery.routeUnreported
            ? {
                reason: 'route-unreported',
                ...(delivery.failureReason ? { cause: delivery.failureReason } : {})
              }
            : (delivery.failureReason ?? { reason: 'route-unreported' })
          notifyDeliveryFailed(label, prompt, reason)
        }
      })
      .catch((error) => {
        console.error('Agent session continuation prompt delivery failed', error)
        notifyDeliveryFailed(label, prompt, { reason: 'route-unreported' })
      })
  }
  return true
}

function notifyLaunchFailed(agentLabel: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.launchFailed',
      'Could not start a new {{agent}} session.',
      { agent: agentLabel }
    )
  )
}

function notifyDeliveryFailed(
  agentLabel: string,
  prompt: string,
  reason: AgentPromptDeliveryFailureReason
): void {
  toast.error(
    describeAgentPromptDeliveryFailure(reason, agentLabel),
    copyPromptToastAction(prompt)
  )
}

/** The prompt was written to the PTY but the agent never showed an input-ready composer. */
function notifyDeliveryUnconfirmed(agentLabel: string, prompt: string): void {
  toast.warning(
    translate(
      'components.agentSessionContinuation.deliveryUnconfirmed',
      'Orca could not confirm {{agent}} received the session context. Check the new session, and paste it yourself if its input is empty.',
      { agent: agentLabel }
    ),
    copyPromptToastAction(prompt)
  )
}
