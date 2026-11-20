import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The structured-native-chat route carries the delivery marker (README §7.11.6
 * bound 1, §7.12 S5/A5).
 *
 * Why a separate file: this route creates a provisional `agent-session` tab
 * through `createUnifiedTab`, not through the terminal path the other launch
 * tests cover. Before §7.12 it dropped `quickCommandLabel`, so the workbench
 * could not see the delivery session it had just started and a second click
 * launched a second agent.
 */

const mocks = vi.hoisted(() => ({
  createUnifiedTab: vi.fn(
    (worktreeId: string, contentType: string, _init?: Record<string, unknown>) => ({
      id: 'tab-provisional',
      worktreeId,
      contentType
    })
  ),
  focusGroup: vi.fn(),
  activateTab: vi.fn(),
  setActiveTabType: vi.fn(),
  store: {
    unifiedTabsByWorktree: {} as Record<string, unknown[]>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.store,
      createUnifiedTab: mocks.createUnifiedTab,
      focusGroup: mocks.focusGroup,
      activateTab: mocks.activateTab,
      setActiveTabType: mocks.setActiveTabType
    })
  }
}))

import { openStructuredAgentSessionProvisionalTab } from './structured-agent-session-provisional-tab'

const WORKTREE_ID = 'repo-1::/work/tree'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.unifiedTabsByWorktree = {}
})

describe('structured provisional tab — the delivery marker', () => {
  it('writes quickCommandLabel into the provisional tab it creates', () => {
    openStructuredAgentSessionProvisionalTab({
      worktreeId: WORKTREE_ID,
      sessionId: 'session-1',
      agent: 'claude',
      quickCommandLabel: 'DELIVER'
    })

    expect(mocks.createUnifiedTab).toHaveBeenCalledTimes(1)
    const [worktreeId, contentType, init] = mocks.createUnifiedTab.mock.calls[0]
    expect(worktreeId).toBe(WORKTREE_ID)
    expect(contentType).toBe('agent-session')
    expect(init).toMatchObject({ quickCommandLabel: 'DELIVER', entityId: 'session-1' })
  })

  it('omits the field for an ordinary launch, so no tab gains a false marker', () => {
    openStructuredAgentSessionProvisionalTab({
      worktreeId: WORKTREE_ID,
      sessionId: 'session-2',
      agent: 'codex'
    })

    const init = mocks.createUnifiedTab.mock.calls[0][2]
    expect(init).not.toHaveProperty('quickCommandLabel')
  })
})
