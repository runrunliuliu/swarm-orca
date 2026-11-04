import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'

// Foreground probes yield; revalidate mailbox authority immediately before either write.
export function canWriteOrchestrationPointer<TWaiter extends OrchestrationMessageWaiter>(
  deps: Pick<
    PointerDeliveryDependencies<TWaiter>,
    'getDb' | 'resolveSubmitTarget' | 'mailboxOwner' | 'getMessageWaiters'
  >,
  state: OrchestrationMailboxPointerState,
  input: {
    ptyId: string
    flight: OrchestrationMailboxDeliveryFlight
    leaf: OrchestrationMailboxLeaf
    mailboxHandle: string
    expectedTarget: OrchestrationMailboxPointerSubmitTarget
    messages: readonly { id: string; type: string }[]
  }
): boolean {
  if (!state.isCurrentFlight(input.ptyId, input.flight)) {
    return false
  }
  const db = deps.getDb()
  const target = deps.resolveSubmitTarget(input.leaf, input.ptyId)
  return Boolean(
    db &&
    target?.leaf.writable &&
    target.terminalHandle === input.expectedTarget.terminalHandle &&
    target.processIncarnation === input.expectedTarget.processIncarnation &&
    target.providerSession === input.expectedTarget.providerSession &&
    target.mailboxConsumer === input.expectedTarget.mailboxConsumer &&
    target.leaf.lastAgentStatusObservedLive &&
    (target.leaf.lastAgentStatus === 'idle' || target.leaf.lastAgentStatus === 'working') &&
    deps.mailboxOwner.resolve(target.leaf, undefined, {
      terminalHandle: target.terminalHandle,
      routeDirectMail: false
    }) === input.mailboxHandle &&
    !shouldReleaseOrchestrationPointer(
      db,
      input.mailboxHandle,
      input.messages,
      deps.getMessageWaiters(input.mailboxHandle)
    )
  )
}
