import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { copyPromptToastAction } from '@/lib/copy-prompt-toast-action'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentPasteFailureReason } from '@/lib/agent-paste-draft'

export type AgentPromptDeliveryFailureReason =
  | AgentPasteFailureReason
  | { reason: 'observed-no-turn' }
  | { reason: 'route-unreported'; cause?: AgentPasteFailureReason }

export function describeAgentPromptDeliveryFailure(
  failure: AgentPromptDeliveryFailureReason,
  agentLabel: string
): string {
  switch (failure.reason) {
    case 'no-pty':
      return translate(
        'components.agentSessionContinuation.deliveryNoPty',
        'No terminal became available for the new {{agent}} session. Open the session, choose Copy prompt, paste it into the input, and press Enter once.',
        { agent: agentLabel }
      )
    case 'ready-timeout':
      return translate(
        'components.agentSessionContinuation.deliveryReadyTimeout',
        '{{agent}} did not become ready, and Orca could not verify its process. Open the session, choose Copy prompt, paste it into the input, and press Enter once.',
        { agent: agentLabel }
      )
    case 'process-mismatch':
      return translate(
        'components.agentSessionContinuation.deliveryProcessMismatch',
        '{{agent}} did not become ready: expected {{expectedProcess}}, but found {{foregroundProcess}}. Check the session or wrapper, then choose Copy prompt, paste the context, and press Enter once.',
        {
          agent: agentLabel,
          expectedProcess: failure.expectedProcess,
          foregroundProcess: failure.foregroundProcess
        }
      )
    case 'observed-no-turn':
      return translate(
        'components.agentSessionContinuation.deliveryObservedNoTurn',
        'Orca wrote the context to {{agent}}, but did not observe a new turn. Check the session; if the input is empty, choose Copy prompt, paste it, and press Enter once.',
        { agent: agentLabel }
      )
    case 'route-unreported':
      if (failure.cause) {
        return describeAgentPromptDeliveryFailure(failure.cause, agentLabel)
      }
      return translate(
        'components.agentSessionContinuation.deliveryRouteUnreported',
        'The new {{agent}} session did not report whether it received the context. Open it; if the input is empty, choose Copy prompt, paste it, and press Enter once.',
        { agent: agentLabel }
      )
  }
}

/**
 * Notice for a post-launch paste that never landed — a stalled readiness wait
 * would otherwise drop the user's text silently.
 *
 * `wasNotified()` reports whether a toast was actually shown, so a deferred
 * caller can suppress a duplicate. It stays false when this surface chose to
 * stay quiet — a closed tab, or a workspace the reader has switched away from —
 * because "nobody here was told" is not the same as "the reader was told", and a
 * delivery that reached no one must not be reported as already communicated
 * (issue #60).
 */
export function createPasteReadinessTimeoutNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
  /**
   * The text that did not make it. When present the notice carries the same copy action the
   * deferred delivery notice uses, so the reader can repair it from whichever notice they see
   * first — the alternative was a first notice with no action that then suppressed the one with it.
   */
  prompt?: string
}): {
  onTimeout: (failure: AgentPasteFailureReason) => void
  wasNotified: () => boolean
  wasUnreported: () => boolean
} {
  let notified = false
  let unreported = false
  return {
    wasNotified: () => notified,
    wasUnreported: () => unreported,
    onTimeout: (failure) => {
      if (notified || unreported) {
        return
      }
      const state = useAppStore.getState()
      const currentTab = (state.tabsByWorktree[args.worktreeId] ?? []).find(
        (tab) => tab.id === args.tabId
      )
      if (currentTab?.ptyId === null) {
        // Why: PTY never spawned = genuine launch failure; stay silent so the caller emits the sole notice.
        unreported = true
        return
      }
      if (!currentTab || state.activeWorktreeId !== args.worktreeId) {
        // Why: the reader cancelled (closed the tab) or is looking at another workspace, so toasting
        // here would land in a surface they are not watching. `notified` stays false on purpose: a
        // deferred caller still owes the reader a durable statement that the text did not arrive.
        unreported = true
        return
      }
      toast.message(
        describeAgentPromptDeliveryFailure(failure, args.agent),
        args.prompt?.trim() ? copyPromptToastAction(args.prompt) : undefined
      )
      notified = true
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}
