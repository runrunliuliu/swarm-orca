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

import { createPasteReadinessTimeoutNotice } from './launch-agent-paste-timeout-notice'

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

    handler.onTimeout()

    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
    // Why "notified": a deferred caller must not repeat the same sentence.
    expect(handler.wasNotified()).toBe(true)
  })

  // Issue #60: this notice is sometimes the only one the reader sees, so it has to carry the repair
  // action itself — a first notice with no action that then suppressed the one with it left the
  // instruction unrecoverable.
  it('carries a copy action that really copies the text that did not make it', () => {
    const handler = notice({ prompt: 'Run the delivery flow.' })

    handler.onTimeout()

    const [, options] = mocks.toastMessage.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } }
    ]
    expect(options.action.label).toBe('Copy prompt')
    options.action.onClick()
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('Run the delivery flow.')
  })

  it('adds no action when the caller has no text to offer', () => {
    const handler = notice()

    handler.onTimeout()

    expect(mocks.toastMessage.mock.calls[0][1]).toBeUndefined()
  })

  // Issue #60: the sentence was never shown, so a deferred caller (the delivery entry) still owes
  // the reader a statement that the instruction did not arrive. Reporting "already told" here is
  // how a failed delivery went completely silent.
  it('stays quiet without claiming the reader was told when the tab is gone', () => {
    const handler = notice({ tabId: 'closed-tab' })

    handler.onTimeout()

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(handler.wasNotified()).toBe(false)
  })

  it('stays quiet without claiming the reader was told when another workspace is active', () => {
    mocks.store.activeWorktreeId = 'wt-2'
    const handler = notice()

    handler.onTimeout()

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(handler.wasNotified()).toBe(false)
  })

  it('leaves a genuine launch failure to the caller', () => {
    mocks.store.tabsByWorktree = { 'wt-1': [{ id: TAB_ID, ptyId: null }] }
    const handler = notice()

    handler.onTimeout()

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(handler.wasNotified()).toBe(false)
  })
})
