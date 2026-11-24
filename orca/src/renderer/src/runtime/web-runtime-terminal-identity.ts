import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { CreatedAgentTerminalIdentity } from './web-runtime-session-types'
import type { RuntimeAgentLaunchPromptDelivery } from '../../../shared/agent-session-host-authority'

export function createdTerminalLeafId(terminal: CreatedAgentTerminalIdentity): string | undefined {
  const pane = parsePaneKey(terminal.paneKey ?? '')
  return pane && pane.tabId === terminal.tabId ? pane.leafId : undefined
}

/** Decode only the host terminal coordinates consumed by the paired renderer. */
export function readCreatedAgentTerminalIdentity(value: unknown): {
  terminal: CreatedAgentTerminalIdentity
  promptDelivery?: RuntimeAgentLaunchPromptDelivery
} {
  if (typeof value !== 'object' || value === null || !('terminal' in value)) {
    throw new Error('Host returned an invalid agent terminal result')
  }
  const terminal = value.terminal
  if (typeof terminal !== 'object' || terminal === null) {
    throw new Error('Host returned an invalid agent terminal identity')
  }
  const tabId = 'tabId' in terminal ? terminal.tabId : undefined
  const paneKey = 'paneKey' in terminal ? terminal.paneKey : undefined
  if (
    (tabId !== undefined && typeof tabId !== 'string') ||
    (paneKey !== undefined && paneKey !== null && typeof paneKey !== 'string')
  ) {
    throw new Error('Host returned invalid agent terminal coordinates')
  }
  const promptDelivery = 'promptDelivery' in value ? value.promptDelivery : undefined
  if (promptDelivery !== undefined && !isPromptDelivery(promptDelivery)) {
    throw new Error('Host returned an invalid launch prompt delivery result')
  }
  return {
    terminal: { tabId, paneKey },
    ...(promptDelivery ? { promptDelivery } : {})
  }
}

function isPromptDelivery(value: unknown): value is RuntimeAgentLaunchPromptDelivery {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    return false
  }
  if (value.state === 'not-requested' || value.state === 'unknown') {
    return true
  }
  return (
    value.state === 'launch-bound' &&
    'transport' in value &&
    (value.transport === 'argv' || value.transport === 'env-hook')
  )
}
