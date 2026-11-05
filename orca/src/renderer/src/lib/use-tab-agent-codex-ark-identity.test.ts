import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'

describe('Codex Ark tab identity', () => {
  it.each([false, true])(
    'retains Ark ownership with Codex process evidence (remote=%s)',
    (isRemote) => {
      const signals = {
        hasObservedAgentSignal: true,
        isRemote,
        title: 'Codex ready',
        hookAgent: null,
        processAgent: 'codex'
      } as const
      expect(resolveTabAgentFromSignals({ ...signals, launchAgent: 'codex-ark' })).toBe('codex-ark')
      expect(resolveTabAgentFromSignals({ ...signals, launchAgent: 'codex' })).toBe('codex')
      expect(resolveTabAgentFromSignals(signals)).toBe('codex')
    }
  )

  it('lets a different foreground agent replace Ark', () => {
    expect(
      resolveTabAgentFromSignals({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'Terminal 1',
        hookAgent: null,
        processAgent: 'claude',
        launchAgent: 'codex-ark'
      })
    ).toBe('claude')
  })
})
