import { describe, expect, it } from 'vitest'
import {
  composeTerminalTitleWithActivity,
  resolveAgentActivitySummary,
  shortenTerminalActivityText,
  TERMINAL_ACTIVITY_SUMMARY_MAX_LENGTH,
  titleCarriesActivityText
} from './terminal-activity-summary'

describe('shortenTerminalActivityText', () => {
  it('folds whitespace and keeps the first clause', () => {
    expect(shortenTerminalActivityText('  Running   the\n test suite. Then review ')).toBe(
      'Running the test suite'
    )
  })

  it('clips long text at a word boundary with an ellipsis', () => {
    const shortened = shortenTerminalActivityText(
      'refactoring the terminal tab title classification ladder for every harness'
    )
    expect(shortened.endsWith('…')).toBe(true)
    expect(Array.from(shortened).length).toBeLessThanOrEqual(
      TERMINAL_ACTIVITY_SUMMARY_MAX_LENGTH + 1
    )
    expect(shortened).not.toContain('  ')
  })

  it('counts code points, not UTF-16 units', () => {
    const shortened = shortenTerminalActivityText('终端活动摘要'.repeat(10), 8)
    expect(Array.from(shortened)).toHaveLength(9)
  })

  it('returns empty for whitespace-only input', () => {
    expect(shortenTerminalActivityText('   \n\t ')).toBe('')
  })
})

describe('titleCarriesActivityText', () => {
  it('reads a harness title with a task line as descriptive', () => {
    expect(titleCarriesActivityText('⠋ Codex — refactoring the parser')).toBe(true)
    expect(titleCarriesActivityText('OC | Native Stable Session')).toBe(true)
  })

  it('treats a bare agent name, decoration, or state word as no description', () => {
    expect(titleCarriesActivityText('Codex')).toBe(false)
    expect(titleCarriesActivityText('⠋ Codex')).toBe(false)
    expect(titleCarriesActivityText('codex working')).toBe(false)
    expect(titleCarriesActivityText('✦ gemini')).toBe(false)
    expect(titleCarriesActivityText('Trae 0.213')).toBe(false)
    expect(titleCarriesActivityText('')).toBe(false)
  })

  it('drops a shell-only title when the pane is known to host an agent', () => {
    expect(titleCarriesActivityText('zsh')).toBe(true)
    expect(titleCarriesActivityText('zsh', { agentIdentityRequired: true })).toBe(false)
  })
})

describe('resolveAgentActivitySummary', () => {
  const base = { state: 'working' as const, prompt: 'Fix the flaky retry test' }

  it("names the running tool, which is the most concrete 'what is it doing'", () => {
    const summary = resolveAgentActivitySummary({
      ...base,
      toolName: 'Edit',
      toolInput: 'src/shared/terminal-activity-summary.ts'
    })
    expect(summary.startsWith('Edit: src/shared/terminal-')).toBe(true)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('uses the tool name alone when the input is empty', () => {
    expect(resolveAgentActivitySummary({ ...base, toolName: 'Bash' })).toBe('Bash')
  })

  it('falls back to the last assistant message, then to the prompt', () => {
    expect(resolveAgentActivitySummary({ ...base, lastAssistantMessage: 'Tests pass now' })).toBe(
      'Tests pass now'
    )
    expect(resolveAgentActivitySummary(base)).toBe('Fix the flaky retry test')
  })

  it('says nothing for finished, interrupted, or background turns', () => {
    expect(resolveAgentActivitySummary({ ...base, state: 'done' })).toBe('')
    expect(resolveAgentActivitySummary({ ...base, interrupted: true })).toBe('')
    expect(resolveAgentActivitySummary({ ...base, workingMode: 'monitoring' })).toBe('')
    expect(resolveAgentActivitySummary({ state: 'working', prompt: '' })).toBe('')
  })
})

describe('composeTerminalTitleWithActivity', () => {
  it('keeps a title that already names work', () => {
    expect(composeTerminalTitleWithActivity('⠋ Codex — refactoring', 'Edit: a.ts')).toBe(
      '⠋ Codex — refactoring'
    )
  })

  it('replaces a bare harness title with the live activity line', () => {
    expect(composeTerminalTitleWithActivity('⠋ Codex', 'Edit: a.ts')).toBe('Edit: a.ts')
    expect(
      composeTerminalTitleWithActivity('zsh', 'Bash: pnpm test', { agentIdentityRequired: true })
    ).toBe('Bash: pnpm test')
  })

  it('leaves the title alone when there is no activity', () => {
    expect(composeTerminalTitleWithActivity('⠋ Codex', '   ')).toBe('⠋ Codex')
  })
})
