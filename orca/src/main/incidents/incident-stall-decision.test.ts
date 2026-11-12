/**
 * The stall predicate (§7.2, M3-2): testable at the exact minute boundary instead of by waiting.
 */
import { describe, expect, it } from 'vitest'
import {
  STALL_REQUIRED_CYCLES,
  STALL_SAMPLE_INTERVAL_MS,
  STALL_THRESHOLD_MS,
  decideStall,
  normalizeThresholds,
  stallAgeMs,
  stallDecisionWrites,
  type StallPaneFacts
} from './incident-stall-decision'

const NOW = 1_700_000_000_000
const EPOCH = NOW - STALL_THRESHOLD_MS

function facts(overrides: Partial<StallPaneFacts> = {}): StallPaneFacts {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'working',
    stateStartedAt: EPOCH,
    turnStartedAt: null,
    observedAt: NOW - 30_000,
    ...overrides
  }
}

describe('defaults', () => {
  it('is 45 minutes, two cycles, one-minute sampling', () => {
    expect(STALL_THRESHOLD_MS).toBe(45 * 60 * 1000)
    expect(STALL_REQUIRED_CYCLES).toBe(2)
    expect(STALL_SAMPLE_INTERVAL_MS).toBe(60 * 1000)
    expect(normalizeThresholds()).toEqual({
      stallMs: STALL_THRESHOLD_MS,
      requiredCycles: 2,
      sampleIntervalMs: 60_000
    })
  })
})

describe('decideStall', () => {
  it('stalls at exactly 45 minutes, not at 44:59', () => {
    const exactly = decideStall({ facts: facts(), now: NOW })
    expect(exactly).toMatchObject({ wouldStall: true, reason: 'stalled', ageMs: STALL_THRESHOLD_MS })
    expect(stallDecisionWrites(exactly)).toBe(true)

    const almost = decideStall({ facts: facts(), now: NOW - 1 })
    expect(almost).toMatchObject({ wouldStall: false, reason: 'below_threshold' })
    expect(almost.ageMs).toBe(STALL_THRESHOLD_MS - 1)
    expect(stallDecisionWrites(almost)).toBe(false)
  })

  it('never stalls a pane that is not working', () => {
    for (const state of ['blocked', 'waiting', 'done']) {
      expect(decideStall({ facts: facts({ state }), now: NOW })).toMatchObject({
        wouldStall: false,
        reason: 'not_working'
      })
    }
  })

  it('treats an unknown state as unknown, never as a stall', () => {
    for (const state of ['', 'rebooting', 'unknown']) {
      expect(decideStall({ facts: facts({ state }), now: NOW }).reason).toBe('unknown_state')
    }
  })

  it('honors a live declaration only for its own epoch', () => {
    const declaration = { reason: 'long build', expiresAt: null, epoch: String(EPOCH) }
    expect(
      decideStall({ facts: facts(), now: NOW, declaration }).reason
    ).toBe('waiting_declared')
    // A respawned pane (new epoch) must not inherit the promise.
    expect(
      decideStall({ facts: facts(), now: NOW, declaration: { ...declaration, epoch: String(EPOCH + 1) } })
        .reason
    ).toBe('stalled')
    // An expired declaration stops applying on its own.
    expect(
      decideStall({
        facts: facts(),
        now: NOW,
        declaration: { ...declaration, expiresAt: NOW - 1 }
      }).reason
    ).toBe('stalled')
  })

  it('requires the configured number of observation cycles', () => {
    expect(
      decideStall({ facts: facts(), now: NOW, cyclesObserved: 1 }).reason
    ).toBe('insufficient_cycles')
    expect(decideStall({ facts: facts(), now: NOW, cyclesObserved: 2 }).reason).toBe('stalled')
    // With a slow sampler, the age alone must not be enough.
    expect(
      decideStall({
        facts: facts(),
        now: NOW,
        thresholds: { sampleIntervalMs: STALL_THRESHOLD_MS }
      }).reason
    ).toBe('insufficient_cycles')
  })

  it('measures age from the later of state and turn start', () => {
    const turnStartedAt = EPOCH + 10 * 60 * 1000
    expect(stallAgeMs(facts({ turnStartedAt }), NOW)).toBe(STALL_THRESHOLD_MS - 10 * 60 * 1000)
    expect(decideStall({ facts: facts({ turnStartedAt }), now: NOW }).reason).toBe(
      'below_threshold'
    )
  })

  it('never reports a negative age when the clock moves backwards', () => {
    // `now` before the state even started (a clock jump): clamp to 0 instead of a negative age.
    expect(stallAgeMs(facts(), EPOCH - 60_000)).toBe(0)
  })
})
