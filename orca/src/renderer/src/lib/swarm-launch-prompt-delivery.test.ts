import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockDeliverLaunchPromptToAgentTab,
  mockPasteDraftToAgentPtyWhenReady,
  mockShowAutomationPromptNotSentToast,
  mockToastMessage,
  mockTrack
} = vi.hoisted(() => ({
  mockDeliverLaunchPromptToAgentTab: vi.fn(),
  mockPasteDraftToAgentPtyWhenReady: vi.fn(),
  mockShowAutomationPromptNotSentToast: vi.fn(),
  mockToastMessage: vi.fn(),
  mockTrack: vi.fn()
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mockDeliverLaunchPromptToAgentTab
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftToAgentPtyWhenReady: mockPasteDraftToAgentPtyWhenReady
}))

vi.mock('@/lib/agent-background-session-timeout-toast', () => ({
  showAutomationPromptNotSentToast: mockShowAutomationPromptNotSentToast
}))

vi.mock('sonner', () => ({ toast: { message: mockToastMessage } }))

vi.mock('@/lib/telemetry', () => ({
  track: mockTrack,
  tuiAgentToAgentKind: () => 'pi'
}))

import { deliverSubmittedLaunchPromptWhenReady } from './swarm-launch-prompt-delivery'

const args = {
  tabId: 'tab-1',
  ptyId: 'pty-1',
  agent: 'pi' as const,
  content: '以 Swarm Coordinator 模式开始工作'
}

describe('deliverSubmittedLaunchPromptWhenReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeliverLaunchPromptToAgentTab.mockResolvedValue(true)
    mockPasteDraftToAgentPtyWhenReady.mockResolvedValue(true)
  })

  it('pastes and submits the brief through the launch-delivery helper', async () => {
    await deliverSubmittedLaunchPromptWhenReady(args)

    expect(mockDeliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'pi',
      content: args.content,
      submit: true,
      forcePaste: true
    })
    // Why: a second paste would duplicate the brief if the first one landed.
    expect(mockPasteDraftToAgentPtyWhenReady).not.toHaveBeenCalled()
    expect(mockToastMessage).not.toHaveBeenCalled()
  })

  it('keeps the brief as an unsubmitted draft when the readiness wait expires', async () => {
    mockDeliverLaunchPromptToAgentTab.mockResolvedValue(false)

    await deliverSubmittedLaunchPromptWhenReady(args)

    expect(mockPasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      agent: 'pi',
      content: args.content,
      forcePaste: true,
      submit: false,
      onTimeout: expect.any(Function)
    })
    expect(mockToastMessage).toHaveBeenCalledTimes(1)
    expect(mockToastMessage.mock.calls[0]?.[0]).toContain('unsent')
    expect(mockTrack).toHaveBeenCalledWith('agent_error', {
      error_class: 'paste_readiness_timeout',
      agent_kind: 'pi'
    })
  })

  it('falls back to the not-sent notice when even the draft paste times out', async () => {
    mockDeliverLaunchPromptToAgentTab.mockResolvedValue(false)
    mockPasteDraftToAgentPtyWhenReady.mockImplementation(
      async (options: { onTimeout?: () => void }) => {
        options.onTimeout?.()
        return false
      }
    )

    await deliverSubmittedLaunchPromptWhenReady(args)

    expect(mockShowAutomationPromptNotSentToast).toHaveBeenCalledWith('pi')
    // Why: one notice, not two — the helper only toasts when the text actually stayed.
    expect(mockToastMessage).not.toHaveBeenCalled()
  })
})
