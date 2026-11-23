import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pasteDraftWhenAgentReady: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
  store: {
    agentStatusByPaneKey: {} as Record<string, { state: string; stateStartedAt?: number }>
  }
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.store,
      seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed
    })
  }
}))

import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from './agent-launch-prompt-delivery'

describe('seedNativeChatLaunchDraftForAgentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mirrors multi-line text — the majority of real drafts', () => {
    // A Linear draft is always `Linked Linear issue: …\n<url>\n`, so rejecting
    // newlines made every Linear launch invisible in chat. Send now clears every
    // parked line first, so there is nothing left to glue.
    const text = 'Linked Linear issue: STA-1234\nhttps://linear.app/o/issue/STA-1234\n'
    seedNativeChatLaunchDraftForAgentTab({ tabId: 'linear-tab', agent: 'codex', text })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'linear-tab',
      agent: 'codex',
      text,
      createdAt: expect.any(Number)
    })
  })
})

describe('deliverLaunchPromptToAgentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('seeds a native-chat launch prompt for supported submitted content', async () => {
    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'codex',
        content: 'Fix failing checks',
        submit: true,
        forcePaste: true
      })
    ).resolves.toBe(true)

    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      text: 'Fix failing checks',
      createdAt: expect.any(Number)
    })
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true,
      timeoutMs: undefined,
      onTimeout: undefined,
      // Why the launch budget: a delivery pastes into a tab it just created, so its spawn is
      // admitted and may outlast the generic 8s verdict (issue #60).
      spawnTimeoutMs: 30_000,
      // Why wrappers: the delivery watches the composer for its own verdict, timestamps the write
      // itself, and forwards the caller's notice through the same callback (issue #60).
      onUnconfirmedDelivery: expect.any(Function),
      onWriteStart: expect.any(Function)
    })
  })

  it('does not seed a launch prompt for drafts, unsupported agents, or empty content', async () => {
    await deliverLaunchPromptToAgentTab({
      tabId: 'draft-tab',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'unsupported-tab',
      agent: 'gemini',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'empty-tab',
      agent: 'claude',
      content: '   ',
      submit: true,
      forcePaste: true
    })

    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })

  it('seeds a native-chat launch draft for supported unsubmitted content', async () => {
    await deliverLaunchPromptToAgentTab({
      tabId: 'draft-tab',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'draft-tab',
      agent: 'codex',
      text: 'Review first',
      createdAt: expect.any(Number)
    })
    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })

  it('does not seed a launch draft for submitted, unsupported, or empty content', async () => {
    await deliverLaunchPromptToAgentTab({
      tabId: 'submit-tab',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'unsupported-tab',
      agent: 'gemini',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'empty-tab',
      agent: 'claude',
      content: '   ',
      submit: false,
      forcePaste: false
    })

    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('keeps the seeded launch draft when paste delivery fails', async () => {
    // A paste timeout means the TUI never got the draft — the composer copy is
    // then the only copy, so it must not be flagged or cleared.
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await deliverLaunchPromptToAgentTab({
      tabId: 'draft-tab',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('marks a seeded launch prompt failed when paste delivery returns false', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'claude',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: true
      })
    ).resolves.toBe(false)

    expect(mocks.markNativeChatLaunchPromptFailed).toHaveBeenCalledWith('tab-1')
  })

  it('marks a seeded launch prompt failed when paste delivery rejects', async () => {
    const error = new Error('prompt transport rejected')
    mocks.pasteDraftWhenAgentReady.mockRejectedValue(error)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'codex',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: true
      })
    ).rejects.toBe(error)

    expect(mocks.markNativeChatLaunchPromptFailed).toHaveBeenCalledWith('tab-1')
  })

  it('treats native-prefill delivery as success without flagging the seeded prompt', async () => {
    // claude delivers via `--prefill` at launch, so paste no-ops (returns false)
    // when forcePaste is false — that is a native delivery, not a failure.
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'claude',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: false
      })
    ).resolves.toBe(true)

    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('does not mark unseeded launches failed', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'gemini',
      content: 'Large generated prompt',
      submit: true,
      forcePaste: true
    })

    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('passes timeout options through to the paste transport', async () => {
    const onTimeout = vi.fn()

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true,
      timeoutMs: 123,
      onTimeout
    })

    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 123, onTimeout })
    )
  })
})

// Issue #60: writing the bytes is not the agent submitting a turn, and the delivery entry needs to
// know the difference. These cases pin each verdict and that none of them resubmits anything.
describe('launch delivery verdict (issue #60)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.agentStatusByPaneKey = {}
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('confirms the submission when the agent starts a turn after the write', async () => {
    mocks.store.agentStatusByPaneKey['tab-1:leaf'] = { state: 'done', stateStartedAt: 1 }
    mocks.pasteDraftWhenAgentReady.mockImplementation(
      async (pasteArgs: { onWriteStart?: () => void }) => {
        // Why the write is announced by the paste helper: the verdict timestamps the write, not the
        // intent to deliver, so a turn that begins in between is not attributed to it.
        pasteArgs.onWriteStart?.()
        mocks.store.agentStatusByPaneKey['tab-1:leaf'] = {
          state: 'working',
          stateStartedAt: Date.now()
        }
        return true
      }
    )
    const verdicts: string[] = []

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'claude',
      content: 'Run the delivery flow.',
      submit: true,
      forcePaste: true,
      onSubmitVerdict: (verdict) => verdicts.push(verdict)
    })

    expect(verdicts).toEqual(['submitted'])
    // One paste, no second write of any kind: the verdict observes, it never repairs.
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(1)
  })

  it('reports unconfirmed for an agent that was already running a turn', async () => {
    mocks.store.agentStatusByPaneKey['tab-1:leaf'] = { state: 'working', stateStartedAt: 1 }
    mocks.pasteDraftWhenAgentReady.mockImplementation(
      async (pasteArgs: { onWriteStart?: () => void }) => {
        pasteArgs.onWriteStart?.()
        return true
      }
    )
    const verdicts: string[] = []

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'claude',
      content: 'Run the delivery flow.',
      submit: true,
      forcePaste: true,
      onSubmitVerdict: (verdict) => verdicts.push(verdict)
    })

    expect(verdicts).toEqual(['unconfirmed'])
  })

  it('reports unconfirmed when a between-turns agent stays between turns', async () => {
    vi.useFakeTimers()
    mocks.store.agentStatusByPaneKey['tab-1:leaf'] = { state: 'done', stateStartedAt: 1 }
    mocks.pasteDraftWhenAgentReady.mockImplementation(
      async (pasteArgs: { onWriteStart?: () => void }) => {
        pasteArgs.onWriteStart?.()
        return true
      }
    )
    const verdicts: string[] = []

    const delivery = deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'claude',
      content: 'Run the delivery flow.',
      submit: true,
      forcePaste: true,
      onSubmitVerdict: (verdict) => verdicts.push(verdict)
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2500)

    await expect(delivery).resolves.toBe(true)
    expect(verdicts).toEqual(['unconfirmed'])
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledTimes(1)
  })

  it('reports unconfirmed for a blind write that observed no composer and no status', async () => {
    mocks.pasteDraftWhenAgentReady.mockImplementation(
      async (pasteArgs: { onWriteStart?: () => void; onUnconfirmedDelivery?: () => void }) => {
        pasteArgs.onWriteStart?.()
        pasteArgs.onUnconfirmedDelivery?.()
        return true
      }
    )
    const verdicts: string[] = []

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'claude',
      content: 'Run the delivery flow.',
      submit: true,
      forcePaste: true,
      onSubmitVerdict: (verdict) => verdicts.push(verdict)
    })

    expect(verdicts).toEqual(['unconfirmed'])
  })

  it('never claims a submission when the paste helper reports no write moment', async () => {
    // Why: an unhooked or mis-wired callback must degrade to the neutral claim, not to "submitted" —
    // the timestamp is the only thing that lets this verdict attribute a turn to the write.
    mocks.store.agentStatusByPaneKey['tab-1:leaf'] = { state: 'working', stateStartedAt: 1 }
    mocks.pasteDraftWhenAgentReady.mockImplementation(async () => true)
    const verdicts: string[] = []

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'claude',
      content: 'Run the delivery flow.',
      submit: true,
      forcePaste: true,
      onSubmitVerdict: (verdict) => verdicts.push(verdict)
    })

    expect(verdicts).toEqual(['written'])
  })

  it('publishes no verdict when nothing was written or nothing was submitted', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)
    const onSubmitVerdict = vi.fn()

    // A draft: the prompt stays editable in the TUI.
    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: true,
      onSubmitVerdict
    })
    // Native prefill: the launch command carried the text, so there is no write to judge.
    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-2',
      agent: 'claude',
      content: 'Run the delivery flow.',
      submit: true,
      forcePaste: false,
      onSubmitVerdict
    })

    expect(onSubmitVerdict).not.toHaveBeenCalled()
  })
})
