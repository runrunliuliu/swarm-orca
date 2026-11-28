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

function followupStartupPlan(agent: 'trae' | 'pi'): AgentStartupPlan {
  return {
    agent,
    launchCommand: agent === 'trae' ? 'traecli --yolo' : 'pi',
    expectedProcess: agent === 'trae' ? 'traecli' : 'pi',
    followupPrompt: 'deliver the task',
    launchConfig: { agentArgs: '--yolo', agentEnv: {} }
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
  mocks.createAgentTerminal.mockResolvedValue({
    outcome: { status: 'created' },
    promptDelivered: true
  })
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

  it.each(['trae', 'pi'] as const)(
    'delegates an unprepared %s prompt to a capable host create operation',
    async (agent) => {
      await launchAgentInWebHostTab({
        agent,
        worktreeId: WORKTREE_ID,
        environmentId: 'env-1',
        startupPlan: followupStartupPlan(agent),
        prompt: 'deliver the task',
        promptDelivery: 'submit-after-ready',
        pastePromptAfterReady: 'deliver the task',
        submitPastedPrompt: true
      })

      expect(mocks.createAgentTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          agent,
          prompt: 'deliver the task',
          promptDelivery: 'auto-submit',
          hostAuthorityCapability: 'agent-session.launch-prompt-delivery.v1'
        })
      )
    }
  )

  it.each([
    ['draft fallback', 'keep this draft editable'],
    ['linked-issue block', 'injected context that must not submit']
  ])('keeps a %s paste on the client instead of binding it to the host', async (_case, text) => {
    await launchAgentInWebHostTab({
      agent: 'trae',
      worktreeId: WORKTREE_ID,
      environmentId: 'env-1',
      startupPlan: followupStartupPlan('trae'),
      prompt: text,
      promptDelivery: 'draft',
      pastePromptAfterReady: text,
      submitPastedPrompt: false
    })

    const request = mocks.createAgentTerminal.mock.calls[0][0]
    expect(request).toMatchObject({
      agent: 'trae',
      promptAfterReady: text,
      submitPrompt: false
    })
    expect(request).not.toHaveProperty('prompt')
    expect(request).not.toHaveProperty('promptDelivery')
    expect(request).not.toHaveProperty('hostAuthorityCapability')
  })

  it('keeps a prepared Trae command on the legacy route without host prompt ownership', async () => {
    await launchAgentInWebHostTab({
      agent: 'trae',
      worktreeId: WORKTREE_ID,
      environmentId: 'env-1',
      startupPlan: followupStartupPlan('trae'),
      prompt: 'deliver the task',
      promptDelivery: 'submit-after-ready',
      pastePromptAfterReady: 'deliver the task',
      submitPastedPrompt: true,
      preparedAgentCommand: true
    })

    const request = mocks.createAgentTerminal.mock.calls[0][0]
    expect(request).toMatchObject({
      preparedAgentCommand: true,
      command: 'traecli --yolo'
    })
    expect(request).not.toHaveProperty('hostAuthorityCapability')
    expect(request).not.toHaveProperty('prompt')
  })

  it('keeps a silent host fallback failure reason for the delivery owner', async () => {
    const failureReason = {
      reason: 'process-mismatch' as const,
      expectedProcess: 'claude',
      foregroundProcess: 'sh'
    }
    mocks.createAgentTerminal.mockResolvedValue({
      outcome: { status: 'created' },
      promptDelivered: false,
      failureReason
    })

    await expect(
      launchAgentInWebHostTab({
        agent: 'claude',
        worktreeId: WORKTREE_ID,
        environmentId: 'env-1',
        startupPlan: startupPlan(),
        prompt: 'deliver the task',
        promptDelivery: 'submit-after-ready',
        pastePromptAfterReady: 'deliver the task',
        submitPastedPrompt: true
      })
    ).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      failureReason,
      routeUnreported: true
    })
  })
})
