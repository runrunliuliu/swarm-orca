import { describe, expect, it } from 'vitest'
import { resolveTerminalTabTitle, resolveUnifiedTabLabel } from './tab-title-resolution'

describe('tab title resolution', () => {
  it('uses live terminal titles when generated titles are disabled', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: 'Claude working' },
        false
      )
    ).toBe('Claude working')
  })

  it('places generated titles between manual and live titles when enabled', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: 'Claude working' },
        true
      )
    ).toBe('Refactor auth')
    expect(
      resolveTerminalTabTitle(
        { customTitle: 'Payments', generatedTitle: 'Refactor auth', title: 'Claude working' },
        true
      )
    ).toBe('Payments')
  })

  it('uses meaningful native OpenCode session titles before generated titles', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          generatedTitle: 'Refactor auth',
          title: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('OC | Native Stable Session')
  })

  it('keeps generated titles ahead of generic OpenCode titles', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: 'OpenCode' },
        true
      )
    ).toBe('Refactor auth')
  })

  it('places quick command labels between manual and generated titles', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          quickCommandLabel: 'Run tests',
          generatedTitle: 'Refactor auth',
          title: 'pnpm test'
        },
        true
      )
    ).toBe('Run tests')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: 'Manual label',
          quickCommandLabel: 'Run tests',
          generatedTitle: 'Refactor auth',
          title: 'pnpm test'
        },
        true
      )
    ).toBe('Manual label')
  })

  it('keeps a Codex thread name stable across activity plus project OSC titles', () => {
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          aiVaultTitle: {
            agent: 'codex',
            sessionId: 'codex-session',
            title: 'Repair provider-native tab titles'
          },
          title: '⠋ albacore'
        },
        false
      )
    ).toBe('Repair provider-native tab titles')
  })

  it('keeps manual and quick-command labels ahead of AI Vault titles', () => {
    const aiVaultTitle = {
      agent: 'claude' as const,
      sessionId: 'claude-session',
      title: 'Claude conversation'
    }
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: 'Manual label',
          quickCommandLabel: 'Run tests',
          aiVaultTitle,
          title: 'claude working'
        },
        false
      )
    ).toBe('Manual label')
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          quickCommandLabel: 'Run tests',
          aiVaultTitle,
          title: 'claude working'
        },
        false
      )
    ).toBe('Run tests')
  })

  it('keeps OpenCode native and Orca-generated title behavior intact', () => {
    const aiVaultTitle = {
      agent: 'codex' as const,
      sessionId: 'codex-session',
      title: 'Codex conversation'
    }
    expect(
      resolveTerminalTabTitle(
        {
          customTitle: null,
          aiVaultTitle,
          generatedTitle: 'Orca generated',
          title: 'OC | OpenCode native'
        },
        true
      )
    ).toBe('OC | OpenCode native')
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Orca generated', title: '⠋ albacore' },
        true
      )
    ).toBe('Orca generated')
  })

  it('shows the live activity line when the title names no work', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: null, title: '⠋ Codex' },
        false,
        'Terminal',
        'Edit: a.ts'
      )
    ).toBe('Edit: a.ts')
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: null, title: '' },
        false,
        'Terminal',
        'Bash: pnpm test'
      )
    ).toBe('Bash: pnpm test')
  })

  it('keeps a rename, a generated title, or a descriptive title ahead of the activity line', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: 'Payments', generatedTitle: null, title: '⠋ Codex' },
        false,
        'Terminal',
        'Edit: a.ts'
      )
    ).toBe('Payments')
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: 'Refactor auth', title: '⠋ Codex' },
        true,
        'Terminal',
        'Edit: a.ts'
      )
    ).toBe('Refactor auth')
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: null, title: '⠋ Codex — refactoring' },
        false,
        'Terminal',
        'Edit: a.ts'
      )
    ).toBe('⠋ Codex — refactoring')
  })

  it('leaves resolution untouched when no activity line is supplied', () => {
    expect(
      resolveTerminalTabTitle(
        { customTitle: null, generatedTitle: null, title: '⠋ Codex' },
        false,
        'Terminal'
      )
    ).toBe('⠋ Codex')
  })

  it('uses the same priority for unified tab labels', () => {
    expect(
      resolveUnifiedTabLabel(
        { customLabel: null, generatedLabel: 'Fix flaky tests', label: 'Codex working' },
        true
      )
    ).toBe('Fix flaky tests')
    expect(
      resolveUnifiedTabLabel(
        { customLabel: null, generatedLabel: null, label: 'Codex' },
        false,
        'Terminal',
        'Edit: a.ts'
      )
    ).toBe('Edit: a.ts')
  })

  it('uses quick command labels before generated unified labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'Codex working'
        },
        true
      )
    ).toBe('Run build')
  })

  it('uses meaningful native OpenCode labels before generated unified labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          generatedLabel: 'Fix flaky tests',
          label: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('OC | Native Stable Session')
  })

  it('keeps manual and quick command labels ahead of native OpenCode labels', () => {
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: 'Manual label',
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('Manual label')
    expect(
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          quickCommandLabel: 'Run build',
          generatedLabel: 'Fix flaky tests',
          label: 'OC | Native Stable Session'
        },
        true
      )
    ).toBe('Run build')
  })
})
