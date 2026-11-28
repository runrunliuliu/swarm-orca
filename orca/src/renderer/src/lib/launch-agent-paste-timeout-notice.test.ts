import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toastMessage: vi.fn(),
  writeClipboardText: vi.fn(),
  store: {
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {} as Record<string, { id: string; ptyId?: string | null }[]>
  }
}))

vi.mock('sonner', () => ({ toast: { message: mocks.toastMessage } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind: (agent: string) => agent }))

import {
  createPasteReadinessTimeoutNotice,
  describeAgentPromptDeliveryFailure
} from './launch-agent-paste-timeout-notice'

const TAB_ID = 'tab-1'

function notice(overrides: { tabId?: string; prompt?: string } = {}) {
  return createPasteReadinessTimeoutNotice({
    worktreeId: 'wt-1',
    tabId: overrides.tabId ?? TAB_ID,
    agent: 'claude',
    submitted: true,
    ...(overrides.prompt === undefined ? {} : { prompt: overrides.prompt })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
  mocks.store.activeWorktreeId = 'wt-1'
  mocks.store.tabsByWorktree = { 'wt-1': [{ id: TAB_ID, ptyId: 'pty-1' }] }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createPasteReadinessTimeoutNotice', () => {
  it('speaks once in the surface the reader is looking at', () => {
    const handler = notice()

    handler.onTimeout({ reason: 'ready-timeout', expectedProcess: 'claude' })

    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
    // Why "notified": a deferred caller must not repeat the same sentence.
    expect(handler.wasNotified()).toBe(true)
  })

  // Issue #60: this notice is sometimes the only one the reader sees, so it has to carry the repair
  // action itself — a first notice with no action that then suppressed the one with it left the
  // instruction unrecoverable.
  it('carries a copy action that really copies the text that did not make it', () => {
    const handler = notice({ prompt: 'Run the delivery flow.' })

    handler.onTimeout({ reason: 'ready-timeout', expectedProcess: 'claude' })

    const [, options] = mocks.toastMessage.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void }; duration: number }
    ]
    expect(options.action.label).toBe('Copy prompt')
    expect(options.duration).toBe(Infinity)
    options.action.onClick()
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('Run the delivery flow.')
  })

  it('adds no action when the caller has no text to offer', () => {
    const handler = notice()

    handler.onTimeout({ reason: 'ready-timeout', expectedProcess: 'claude' })

    expect(mocks.toastMessage.mock.calls[0][1]).toBeUndefined()
  })

  // Issue #60: the sentence was never shown, so a deferred caller (the delivery entry) still owes
  // the reader a statement that the instruction did not arrive. Reporting "already told" here is
  // how a failed delivery went completely silent.
  it('stays quiet without claiming the reader was told when the tab is gone', () => {
    const handler = notice({ tabId: 'closed-tab' })

    handler.onTimeout({ reason: 'ready-timeout', expectedProcess: 'claude' })

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(handler.wasNotified()).toBe(false)
    expect(handler.wasUnreported()).toBe(true)
  })

  it('stays quiet without claiming the reader was told when another workspace is active', () => {
    mocks.store.activeWorktreeId = 'wt-2'
    const handler = notice()

    handler.onTimeout({ reason: 'ready-timeout', expectedProcess: 'claude' })

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(handler.wasNotified()).toBe(false)
    expect(handler.wasUnreported()).toBe(true)
  })

  it('leaves a genuine launch failure to the caller', () => {
    mocks.store.tabsByWorktree = { 'wt-1': [{ id: TAB_ID, ptyId: null }] }
    const handler = notice()

    handler.onTimeout({ reason: 'no-pty' })

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(handler.wasNotified()).toBe(false)
    expect(handler.wasUnreported()).toBe(true)
  })

  it('names an observed process mismatch and remains idempotent', () => {
    const handler = notice({ prompt: 'Run the delivery flow.' })

    const failure = {
      reason: 'process-mismatch' as const,
      expectedProcess: 'traecli',
      foregroundProcess: 'sh'
    }
    handler.onTimeout(failure)
    handler.onTimeout(failure)

    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
    expect((mocks.toastMessage.mock.calls[0] as [string])[0]).toContain('traecli')
    expect((mocks.toastMessage.mock.calls[0] as [string])[0]).toContain('sh')
  })
})

describe('describeAgentPromptDeliveryFailure', () => {
  it('uses a route-unreported no-PTY cause instead of hiding it behind the route', () => {
    expect(
      describeAgentPromptDeliveryFailure(
        { reason: 'route-unreported', cause: { reason: 'no-pty' } },
        'Claude'
      )
    ).toBe(
      'No terminal became available for the new Claude session. Open the session, choose Copy prompt, paste it into the input, and press Enter once.'
    )
  })

  it('uses a route-unreported readiness cause instead of hiding it behind the route', () => {
    expect(
      describeAgentPromptDeliveryFailure(
        {
          reason: 'route-unreported',
          cause: { reason: 'ready-timeout', expectedProcess: 'claude' }
        },
        'Claude'
      )
    ).toBe(
      'Claude did not become ready, and Orca could not verify its process. Open the session, choose Copy prompt, paste it into the input, and press Enter once.'
    )
  })

  it('uses a route-unreported process mismatch cause instead of hiding it behind the route', () => {
    expect(
      describeAgentPromptDeliveryFailure(
        {
          reason: 'route-unreported',
          cause: {
            reason: 'process-mismatch',
            expectedProcess: 'claude',
            foregroundProcess: 'sh'
          }
        },
        'Claude'
      )
    ).toBe(
      'Claude did not become ready: expected claude, but found sh. Check the session or wrapper, then choose Copy prompt, paste the context, and press Enter once.'
    )
  })

  it('keeps the route-unreported copy when no deeper cause exists', () => {
    expect(describeAgentPromptDeliveryFailure({ reason: 'route-unreported' }, 'Claude')).toBe(
      'The new Claude session did not report whether it received the context. Open it; if the input is empty, choose Copy prompt, paste it, and press Enter once.'
    )
  })
})
