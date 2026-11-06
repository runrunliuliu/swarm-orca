import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveTerminalPaletteTitles } from './workspace-tab-palette-terminal-title'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'worktree-1',
    title: '⠋ Codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function unifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'unified-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    label: '⠋ Codex',
    contentType: 'terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

describe('resolveTerminalPaletteTitles', () => {
  it('shows the activity line as the row second line and as the label when the title is bare', () => {
    const titles = resolveTerminalPaletteTitles({
      tab: unifiedTab(),
      terminalTab: terminalTab(),
      generatedTitlesEnabled: true,
      activitySummaryByTabId: new Map([['tab-1', 'Edit: a.ts']])
    })
    expect(titles.title).toBe('Edit: a.ts')
    expect(titles.secondaryText).toBe('Edit: a.ts')
    expect(titles.secondaryTexts).toEqual(['Edit: a.ts'])
  })

  it('keeps a descriptive title and still reports the activity line', () => {
    const titles = resolveTerminalPaletteTitles({
      tab: unifiedTab({ label: '⠋ Codex — refactoring' }),
      terminalTab: terminalTab({ title: '⠋ Codex — refactoring' }),
      generatedTitlesEnabled: true,
      activitySummaryByTabId: new Map([['tab-1', 'Edit: a.ts']])
    })
    expect(titles.title).toBe('⠋ Codex — refactoring')
    expect(titles.secondaryText).toBe('Edit: a.ts')
  })

  it('has nothing to add when no pane reported activity', () => {
    const titles = resolveTerminalPaletteTitles({
      tab: unifiedTab(),
      terminalTab: terminalTab(),
      generatedTitlesEnabled: true
    })
    expect(titles.title).toBe('⠋ Codex')
    expect(titles.secondaryText).toBe('')
    expect(titles.secondaryTexts).toEqual([])
  })
})
