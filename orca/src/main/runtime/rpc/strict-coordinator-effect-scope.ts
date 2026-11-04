import { isOrchestrationMutation } from '../../../shared/orchestration-rpc-contract'

const SESSION_READS = new Set([
  'agentSession.history',
  'agentSession.commands',
  'agentSession.options',
  'agentSession.modelCatalog',
  'agentSession.conversationOutline',
  'agentSession.handoffStatus',
  'agentSession.subscribe',
  'agentSession.subscribeStatus',
  'agentSession.subscribeTurnCompletions',
  'agentSession.unsubscribe',
  'agentSession.reveal'
])

export function isStrictSessionEffect(method: string): boolean {
  return method.startsWith('agentSession.') && !SESSION_READS.has(method)
}

// Keep admission and quiescence aligned, including non-durable input and mailbox waits.
export function isStrictCoordinatorEffect(method: string, params: unknown): boolean {
  return (
    isOrchestrationMutation(method, params) ||
    method === 'orchestration.check' ||
    method === 'terminal.send' ||
    isStrictSessionEffect(method)
  )
}
