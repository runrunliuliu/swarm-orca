import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  reportAgentPromptDeliveryFailure: vi.fn()
}))

type StoreState = Record<string, unknown>

const state: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: () => () => undefined
  }
}))

vi.mock('@/lib/agent-prompt-delivery-failure', () => ({
  reportAgentPromptDeliveryFailure: mocks.reportAgentPromptDeliveryFailure
}))

import {
  queuePendingAgentStartupDelivery,
  resetAgentStartupDelayedDeliveryForTests
} from './agent-startup-delayed-delivery'

const startup = {
  agent: 'codex' as const,
  launchCommand: 'codex',
  expectedProcess: 'codex',
  followupPrompt: null,
  launchConfig: { agentArgs: '', agentEnv: {} },
  draftPrompt: 'Coordinator brief'
}

const delivery = {
  worktreeId: 'worktree-1',
  tabId: 'tab-1',
  launchToken: 'launch-1',
  startup,
  deliver: vi.fn()
}

describe('queued agent startup delivery failures', () => {
  beforeEach(() => {
    mocks.reportAgentPromptDeliveryFailure.mockReset()
    delivery.deliver.mockReset()
    Object.assign(state, {
      tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
      pendingStartupByTabId: { 'tab-1': { launchToken: 'launch-1' } },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1' } } },
      agentLaunchConfigByPaneKey: {
        'tab-1:leaf-1': { identity: { tabId: 'tab-1', launchToken: 'launch-1', leafId: 'leaf-1' } }
      }
    })
  })

  afterEach(() => {
    resetAgentStartupDelayedDeliveryForTests()
  })

  it('reports a rejected queued delivery once, instead of only warning', async () => {
    // Why: this queue outlives the create screen, so a `console.warn` here left the user with
    // an agent that never received its first prompt and no way to tell (#54).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    delivery.deliver.mockRejectedValue(new Error('pty write failed'))

    queuePendingAgentStartupDelivery(delivery)

    await vi.waitFor(() =>
      expect(mocks.reportAgentPromptDeliveryFailure).toHaveBeenCalledWith('codex')
    )
    expect(mocks.reportAgentPromptDeliveryFailure).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
