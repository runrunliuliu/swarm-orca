/**
 * The 5-in-10-minutes window (§7.3): the boundary, the reset, and the high-severity short-circuit.
 */
import { describe, expect, it } from 'vitest'
import {
  TOOL_ERROR_THRESHOLD,
  TOOL_ERROR_WINDOW_MS,
  createToolErrorWindowTracker
} from './incident-tool-error-window'

const T0 = 1_700_000_000_000
const key = { sessionId: 's-1', turn: 'turn-1', toolName: 'Bash', code: 'non_zero_exit' }

function recordAt(
  tracker: ReturnType<typeof createToolErrorWindowTracker>,
  at: number,
  overrides: Partial<typeof key> & { highSeverity?: boolean } = {}
) {
  return tracker.record({
    ...key,
    ...overrides,
    at,
    highSeverity: overrides.highSeverity ?? false
  })
}

describe('tool-error window', () => {
  it('defaults to 5 events in 10 minutes', () => {
    expect(TOOL_ERROR_THRESHOLD).toBe(5)
    expect(TOOL_ERROR_WINDOW_MS).toBe(10 * 60 * 1000)
  })

  it('does not open at 4, opens at exactly 5, and keeps the first event as the window start', () => {
    const tracker = createToolErrorWindowTracker()
    for (let index = 0; index < 4; index += 1) {
      expect(recordAt(tracker, T0 + index * 1000).wouldWriteIfEnabled).toBe(false)
    }
    const fifth = recordAt(tracker, T0 + 4000)
    expect(fifth).toMatchObject({ count: 5, wouldWriteIfEnabled: true, windowStart: T0 })
  })

  it('drops events that fall out of the window before counting', () => {
    const tracker = createToolErrorWindowTracker()
    for (let index = 0; index < 4; index += 1) {
      recordAt(tracker, T0 + index * 1000)
    }
    // The first four are now older than 10 minutes, so this is a fresh window of one.
    const afterGap = recordAt(tracker, T0 + TOOL_ERROR_WINDOW_MS + 5000)
    expect(afterGap).toMatchObject({ count: 1, wouldWriteIfEnabled: false })
    expect(afterGap.windowStart).toBe(T0 + TOOL_ERROR_WINDOW_MS + 5000)
  })

  it('opens on the first high-severity event', () => {
    const tracker = createToolErrorWindowTracker()
    const first = recordAt(tracker, T0, { code: 'permission_denied', highSeverity: true })
    expect(first).toMatchObject({ count: 1, wouldWriteIfEnabled: true, highSeverity: true })
  })

  it('never merges counts across turns (M4-C2)', () => {
    const tracker = createToolErrorWindowTracker()
    for (let index = 0; index < 3; index += 1) {
      recordAt(tracker, T0 + index, { turn: 'turn-A' })
    }
    // Same code, new turn: two fresh events are not the third and fourth of the previous turn.
    for (let index = 0; index < 2; index += 1) {
      const result = recordAt(tracker, T0 + 10 + index, { turn: 'turn-B' })
      expect(result.count).toBe(index + 1)
      expect(result.wouldWriteIfEnabled).toBe(false)
    }
    // And five in one turn still opens.
    for (let index = 0; index < 5; index += 1) {
      const result = recordAt(tracker, T0 + 20 + index, { turn: 'turn-C' })
      if (index === 4) {
        expect(result.wouldWriteIfEnabled).toBe(true)
      }
    }
  })

  it('counts each session/tool/code separately', () => {
    const tracker = createToolErrorWindowTracker()
    for (let index = 0; index < 4; index += 1) {
      recordAt(tracker, T0 + index)
    }
    const otherTool = recordAt(tracker, T0 + 4, { toolName: 'Read' })
    expect(otherTool.wouldWriteIfEnabled).toBe(false)
    const otherSession = recordAt(tracker, T0 + 5, { sessionId: 's-2' })
    expect(otherSession.wouldWriteIfEnabled).toBe(false)
  })

  it('marks a written window so a burst produces one incident, and resets on a new window', () => {
    const tracker = createToolErrorWindowTracker()
    for (let index = 0; index < 5; index += 1) {
      recordAt(tracker, T0 + index)
    }
    const before = tracker.snapshot()[0]
    tracker.markWritten(key, before.windowStart)
    expect(tracker.snapshot()[0].written).toBe(true)
    expect(recordAt(tracker, T0 + 6).alreadyWritten).toBe(true)

    // A later window (all earlier events expired) is not "already written".
    const next = recordAt(tracker, T0 + TOOL_ERROR_WINDOW_MS + 10_000)
    expect(next.windowStart).toBeGreaterThan(before.windowStart)
    expect(next.alreadyWritten).toBe(false)
  })

  it('bounds the number of tracked windows', () => {
    const tracker = createToolErrorWindowTracker({ maxEntries: 2 })
    recordAt(tracker, T0, { toolName: 'A' })
    recordAt(tracker, T0, { toolName: 'B' })
    recordAt(tracker, T0, { toolName: 'C' })
    expect(tracker.size()).toBe(2)
    expect(tracker.evicted()).toBe(1)
    expect(tracker.snapshot().map((window) => window.toolName).sort()).toEqual(['B', 'C'])
  })
})
