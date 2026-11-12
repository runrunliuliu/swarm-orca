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
    lastSemanticEventAt: null,
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
  it('flags exactly 45 minutes of silence, not 44:59', () => {
    const exactly = decideStall({ facts: facts(), now: NOW })
    expect(exactly).toMatchObject({
      wouldWriteIfEnabled: true,
      reason: 'no_event_for_threshold',
      ageMs: STALL_THRESHOLD_MS,
      ageBasis: 'state_fallback'
    })
    expect(stallDecisionWrites(exactly)).toBe(true)

    const almost = decideStall({ facts: facts(), now: NOW - 1 })
    expect(almost).toMatchObject({ wouldWriteIfEnabled: false, reason: 'below_threshold' })
    expect(almost.ageMs).toBe(STALL_THRESHOLD_MS - 1)
    expect(stallDecisionWrites(almost)).toBe(false)
  })

  it('uses the semantic event clock, so a long turn with fresh events is not a stall', () => {
    // 3 hours in the same turn, but the last semantic event was one minute ago.
    const longTurn = facts({
      stateStartedAt: NOW - 3 * 60 * 60 * 1000,
      turnStartedAt: NOW - 3 * 60 * 60 * 1000,
      lastSemanticEventAt: NOW - 60_000
    })
    const decision = decideStall({ facts: longTurn, now: NOW, cyclesObserved: 10 })
    expect(decision).toMatchObject({
      wouldWriteIfEnabled: false,
      reason: 'below_threshold',
      ageBasis: 'event',
      ageMs: 60_000
    })
    // The epoch is still stateStartedAt (idempotency), not the event clock.
    expect(decision.epoch).toBe(longTurn.stateStartedAt)
  })

  it('marks the state_started fallback explicitly instead of pretending it is a semantic age', () => {
    const withEvent = decideStall({
      facts: facts({ lastSemanticEventAt: EPOCH, stateStartedAt: EPOCH }),
      now: NOW
    })
    expect(withEvent.ageBasis).toBe('event')
    const fallback = decideStall({ facts: facts({ lastSemanticEventAt: null }), now: NOW })
    expect(fallback.ageBasis).toBe('state_fallback')
  })

  it('never stalls a pane that is not working', () => {
    for (const state of ['blocked', 'waiting', 'done']) {
      expect(decideStall({ facts: facts({ state }), now: NOW })).toMatchObject({
        wouldWriteIfEnabled: false,
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
    ).toBe('no_event_for_threshold')
    // An expired declaration stops applying on its own.
    expect(
      decideStall({
        facts: facts(),
        now: NOW,
        declaration: { ...declaration, expiresAt: NOW - 1 }
      }).reason
    ).toBe('no_event_for_threshold')
  })

  it('requires the configured number of observation cycles', () => {
    expect(
      decideStall({ facts: facts(), now: NOW, cyclesObserved: 1 }).reason
    ).toBe('insufficient_cycles')
    expect(decideStall({ facts: facts(), now: NOW, cyclesObserved: 2 }).reason).toBe(
      'no_event_for_threshold'
    )
    // With a slow sampler, the age alone must not be enough.
    expect(
      decideStall({
        facts: facts(),
        now: NOW,
        thresholds: { sampleIntervalMs: STALL_THRESHOLD_MS }
      }).reason
    ).toBe('insufficient_cycles')
  })

  it('does not use turnStartedAt as the age basis', () => {
    // A turn that started recently is not an event: only the semantic clock (or the stated fallback)
    // decides. Without an event clock the age still comes from stateStartedAt.
    const turnStartedAt = EPOCH + 10 * 60 * 1000
    expect(stallAgeMs(facts({ turnStartedAt }), NOW)).toBe(STALL_THRESHOLD_MS)
    expect(decideStall({ facts: facts({ turnStartedAt }), now: NOW }).reason).toBe(
      'no_event_for_threshold'
    )
  })

  it('never reports a negative age when the clock moves backwards', () => {
    // `now` before the state even started (a clock jump): clamp to 0 instead of a negative age.
    expect(stallAgeMs(facts(), EPOCH - 60_000)).toBe(0)
  })
})
