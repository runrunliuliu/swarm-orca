import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import { extractAgentProviderSession } from '../../agent-session-resume'
import type { HookListenerState } from '../listener-state'
import { normalizeCompatibleLifecycleEvent } from './compatible-lifecycle-events'

/** Trae 0.209.1 command-hook schema; unknown events do not establish ownership. */
export function normalizeTraeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  payload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (payload.agent_id != null || !extractAgentProviderSession('trae', payload)) {
    return null
  }
  if (eventName !== 'SessionStart' && eventName !== 'UserPromptSubmit' && eventName !== 'Stop') {
    return null
  }
  // Compact/fork may occur inside an active turn; neither is an idle boundary.
  if (
    eventName === 'SessionStart' &&
    !['startup', 'resume', 'clear'].includes(String(payload.source))
  ) {
    return null
  }
  return normalizeCompatibleLifecycleEvent('trae', state, eventName, promptText, paneKey, payload)
}
