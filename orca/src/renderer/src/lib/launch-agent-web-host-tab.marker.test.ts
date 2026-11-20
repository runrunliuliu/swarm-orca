import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartupPlan } from './tui-agent-startup'

/**
 * The host-published route forwards the delivery marker (README §7.11.6 bound
 * 2, §7.12 S5/A5).
 *
 * Why this is a forwarding assertion and not a wire assertion: the host
 * transport carries no tab marker, so §7.12 marks the mirrored local row after
 * the host accepts the launch (see `web-runtime-terminal-create-operation.ts`).
 * What this file owns is the half on this side: the marker travels from the
 * launch call into the runtime creation request instead of being dropped.
 */

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  createAgentTerminal: vi.fn(),
  createAgentTerminalWithDraft: vi.fn(),
  setActiveTabType: vi.fn(),
  store: {
    tabsByWorktree: {} as Record<string, unknown[]>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.store,
      setActiveTabType: mocks.setActiveTabType,
      closeTab: vi.fn()
    })
  }
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createTerminal,
  createWebRuntimeAgentSessionTerminal: mocks.createAgentTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: mocks.createAgentTerminalWithDraft,
  isWebTerminalSurfaceTabId: () => false
}))

import { launchAgentInWebHostTab } from './launch-agent-web-host-tab'

const WORKTREE_ID = 'repo-1::/work/tree'

function startupPlan(): AgentStartupPlan {
  return {
    agent: 'claude',
    launchCommand: 'claude',
    expectedProcess: 'claude',
    followupPrompt: null,
    launchConfig: { agentArgs: '', agentEnv: {} }
  }
}

function launch(quickCommandLabel?: string): Promise<unknown> {
  return launchAgentInWebHostTab({
    agent: 'claude',
    worktreeId: WORKTREE_ID,
    environmentId: 'env-1',
    startupPlan: startupPlan(),
    prompt: '',
    promptDelivery: 'auto-submit',
    pastePromptAfterReady: null,
    submitPastedPrompt: false,
    ...(quickCommandLabel ? { quickCommandLabel } : {})
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.tabsByWorktree = {}
  mocks.createTerminal.mockResolvedValue({ status: 'created' })
})

describe('launchAgentInWebHostTab — the delivery marker', () => {
  it('forwards quickCommandLabel into the runtime creation request', async () => {
    await launch('DELIVER')

    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.createTerminal.mock.calls[0][0]).toMatchObject({
      worktreeId: WORKTREE_ID,
      quickCommandLabel: 'DELIVER'
    })
  })

  it('sends no marker for an ordinary launch', async () => {
    await launch()

    expect(mocks.createTerminal.mock.calls[0][0]).not.toHaveProperty('quickCommandLabel')
  })
})
