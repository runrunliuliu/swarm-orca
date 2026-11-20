import { describe, expect, it } from 'vitest'
import { sessionTokenTotals, sessionTokensFor } from './task-workbench-session-totals'

describe('session token attribution', () => {
  it('uses the one provider figure for a session only one provider reports', () => {
    const totals = sessionTokenTotals([{ sessionId: 'abc', tokens: 1_200 }])

    expect(sessionTokensFor(totals, 'abc')).toBe(1_200)
  })

  it('does not pick or add when one session is claimed by two providers', () => {
    // Claude and Codex both reporting `abc` means the id cannot be attributed to
    // one provider, so the row must stay unknown rather than show either figure
    // or their sum (README §7.5).
    const totals = sessionTokenTotals([
      { sessionId: 'abc', tokens: 1_200 },
      { sessionId: 'abc', tokens: 300 }
    ])

    expect(sessionTokensFor(totals, 'abc')).toBeNull()
  })

  it('keeps a measured zero and treats an absent session as unknown', () => {
    const totals = sessionTokenTotals([
      { sessionId: 'zero', tokens: 0 },
      { sessionId: '', tokens: 99 }
    ])

    expect(sessionTokensFor(totals, 'zero')).toBe(0)
    expect(sessionTokensFor(totals, 'missing')).toBeNull()
    expect(sessionTokensFor(totals, undefined)).toBeNull()
    expect(totals.has('')).toBe(false)
  })
})
