import { describe, expect, it } from 'vitest'
import type { AgentTokenView, SpendReason, SpendView } from './task-workbench-view'
import {
  USAGE_STATUS_ORDER,
  spendStatus,
  tokenText,
  usageStatusIsUnavailable,
  usageStatusLabelKey
} from './task-workbench-usage-status'

// Spell every reason token out. These strings are the copy of record that F4 /
// F7 / F10 / F11 print verbatim, so a rename in the source has to fail here.
const REASONS = [
  'disabled',
  'unpriced',
  'ambiguous_session',
  'no_matching_session',
  'remote_host',
  'unattributed'
] as const satisfies readonly SpendReason[]

describe('spendStatus', () => {
  it('maps every unavailable reason onto itself, verbatim', () => {
    for (const reason of REASONS) {
      expect(spendStatus({ kind: 'unavailable', reason })).toBe(reason)
    }
  })

  it('maps each reason onto exactly one distinct status', () => {
    const mapped = REASONS.map((reason) => spendStatus({ kind: 'unavailable', reason }))
    expect(new Set(mapped).size).toBe(REASONS.length)
    for (const status of mapped) {
      expect(status).not.toBe('available')
      expect(USAGE_STATUS_ORDER).toContain(status)
    }
  })

  it('reports an available spend as available, never as a reason', () => {
    const view: SpendView = {
      kind: 'available',
      tokens: 1_360_000,
      costUsd: 1.82,
      byProvider: [{ provider: 'claude', tokens: 412_000, costUsd: 1.2 }],
      unattributedSessions: 0
    }
    expect(spendStatus(view)).toBe('available')
  })

  it('carries no number when the spend is unavailable', () => {
    for (const reason of REASONS) {
      const view: SpendView = { kind: 'unavailable', reason }
      // Only the discriminator and the reason: nothing numeric to read as `$0`.
      expect(Object.keys(view).sort()).toEqual(['kind', 'reason'])
      expect(usageStatusIsUnavailable(spendStatus(view))).toBe(true)
    }
  })
})

describe('USAGE_STATUS_ORDER', () => {
  it('lists every status exactly once, available first', () => {
    expect(USAGE_STATUS_ORDER.length).toBe(7)
    expect(new Set(USAGE_STATUS_ORDER).size).toBe(7)
    expect(USAGE_STATUS_ORDER[0]).toBe('available')
  })

  it('contains every spend reason, so the two vocabularies cannot drift', () => {
    for (const reason of REASONS) {
      expect(USAGE_STATUS_ORDER).toContain(reason)
    }
  })
})

describe('usageStatusIsUnavailable', () => {
  it('is false for available and true for every other status', () => {
    expect(usageStatusIsUnavailable('available')).toBe(false)
    for (const status of USAGE_STATUS_ORDER) {
      if (status !== 'available') {
        expect(usageStatusIsUnavailable(status)).toBe(true)
      }
    }
  })
})

describe('usageStatusLabelKey', () => {
  it('builds the catalog key for every status', () => {
    expect(usageStatusLabelKey('available')).toBe(
      'auto.components.TaskWorkbenchSpend.status.available'
    )
    expect(usageStatusLabelKey('disabled')).toBe(
      'auto.components.TaskWorkbenchSpend.status.disabled'
    )
    expect(usageStatusLabelKey('unpriced')).toBe(
      'auto.components.TaskWorkbenchSpend.status.unpriced'
    )
    expect(usageStatusLabelKey('ambiguous_session')).toBe(
      'auto.components.TaskWorkbenchSpend.status.ambiguous_session'
    )
    expect(usageStatusLabelKey('no_matching_session')).toBe(
      'auto.components.TaskWorkbenchSpend.status.no_matching_session'
    )
    expect(usageStatusLabelKey('remote_host')).toBe(
      'auto.components.TaskWorkbenchSpend.status.remote_host'
    )
    expect(usageStatusLabelKey('unattributed')).toBe(
      'auto.components.TaskWorkbenchSpend.status.unattributed'
    )
  })
})

describe('tokenText', () => {
  it('prints an available rollup count', () => {
    expect(tokenText({ kind: 'rollup', tokens: 412_000 })).toEqual({
      text: '412000',
      unavailable: false
    })
    expect(tokenText({ kind: 'ai-vault', tokens: 61_000, caveat: 'retained session' })).toEqual({
      text: '61000',
      unavailable: false
    })
  })

  it('keeps a real zero a zero, because it was measured', () => {
    expect(tokenText({ kind: 'rollup', tokens: 0 })).toEqual({ text: '0', unavailable: false })
  })

  it('prints an em dash for every unavailable reason, never a zero', () => {
    for (const reason of REASONS) {
      const view: AgentTokenView = { kind: 'unavailable', reason }
      expect(tokenText(view)).toEqual({ text: '—', unavailable: true })
    }
  })

  it('never reports an unpriced token as 0 or $0', () => {
    const unpriced: AgentTokenView = { kind: 'unavailable', reason: 'unpriced' }
    const { text, unavailable } = tokenText(unpriced)
    expect(text).toBe('—')
    expect(unavailable).toBe(true)
    expect(text).not.toBe('0')
    expect(text).not.toContain('$')
    expect(Number.isNaN(Number(text))).toBe(true)
  })
})
