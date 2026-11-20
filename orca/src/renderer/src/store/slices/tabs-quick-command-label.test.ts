import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'

/**
 * `setTabQuickCommandLabel` — the host-published route's marker write (README
 * §7.12 S5/A5).
 *
 * Why a store test: the host transport has no tab-marker field, so the launch
 * marks the mirrored local row after the host accepts it. That row is what the
 * workbench reads (`DashboardCard.conversationName`), and it must be written to
 * both indices the launcher searches — otherwise a reload-style lookup on the
 * legacy row would lose the marker.
 */

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('setTabQuickCommandLabel', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  it('writes the marker on the unified tab and the terminal row', () => {
    const tab = store
      .getState()
      .createTab(WT, undefined, undefined, { launchAgent: 'claude' })

    store.getState().setTabQuickCommandLabel(tab.id, 'DELIVER')

    const unified = store.getState().unifiedTabsByWorktree[WT]?.find((row) => row.id === tab.id)
    const terminal = store.getState().tabsByWorktree[WT]?.find((row) => row.id === tab.id)
    expect(unified?.quickCommandLabel).toBe('DELIVER')
    expect(terminal?.quickCommandLabel).toBe('DELIVER')
  })

  it('leaves other tabs untouched', () => {
    const marked = store.getState().createTab(WT, undefined, undefined, {})
    const other = store.getState().createTab(WT, undefined, undefined, {})

    store.getState().setTabQuickCommandLabel(marked.id, 'DELIVER')

    const otherRow = store.getState().tabsByWorktree[WT]?.find((row) => row.id === other.id)
    expect(otherRow?.quickCommandLabel).toBeUndefined()
  })

  it('is a no-op for an unknown tab id', () => {
    const before = store.getState().unifiedTabsByWorktree

    store.getState().setTabQuickCommandLabel('tab-missing', 'DELIVER')

    expect(store.getState().unifiedTabsByWorktree).toBe(before)
  })
})
