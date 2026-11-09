import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { buildHeadlessMobileSessionTerminalTabs } from './mobile-session-terminal-projection'

const WORKTREE_ID = 'wt'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function session(tab: TerminalTab): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: WORKTREE_ID,
    activeTabId: tab.id,
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    terminalLayoutsByTabId: {}
  }
}

describe('buildHeadlessMobileSessionTerminalTabs spawnedFromPaneKey', () => {
  it('projects an explicit user-spawn source pane from the persisted terminal tab', () => {
    const sourceTab = terminalTab({
      spawnedFromPaneKey: 'parent-tab:11111111-1111-4111-8111-111111111111'
    })
    const [surface] = buildHeadlessMobileSessionTerminalTabs(
      WORKTREE_ID,
      [sourceTab],
      session(sourceTab)
    )

    expect(surface?.spawnedFromPaneKey).toBe(
      'parent-tab:11111111-1111-4111-8111-111111111111'
    )
  })

  it('leaves source-unknown terminal tabs unparented', () => {
    const sourceTab = terminalTab()
    const [surface] = buildHeadlessMobileSessionTerminalTabs(
      WORKTREE_ID,
      [sourceTab],
      session(sourceTab)
    )

    expect(surface?.spawnedFromPaneKey).toBeUndefined()
  })
})
