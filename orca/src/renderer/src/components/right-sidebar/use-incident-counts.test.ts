// @vitest-environment happy-dom

/**
 * The counts hook's availability states (M7-D, from the pre-merge review).
 *
 * The review's point was about *silence*: `useIncidentCounts` used to collapse "nothing arrived yet",
 * "the read failed" and "the reading is old" into the same `null`, which the badge drew as nothing —
 * pixel-identical to a complete and empty store. These cases pin the four states apart, and pin the
 * two transitions that matter: a push clears staleness, and a failure never fabricates a reading.
 *
 * The staleness deadline is driven by `readAt` against the renderer clock, so the clock is controlled
 * here (fake timers + `setSystemTime`) instead of waiting ten real minutes.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentCountsDto } from '../../../../shared/incident-api-types'
import { countsFixture } from './incidents/incident-panel-fixtures'
import {
  INCIDENT_COUNTS_STALE_MS,
  useIncidentCounts,
  type IncidentCountsState
} from './use-incident-counts'

const T0 = 1_700_000_000_000

type PushListener = (next: IncidentCountsDto) => void

/**
 * One fake bridge: the first `counts()` call resolves (or fails) per the test, and pushes are delivered
 * through the captured listener. Mirrors the preload shape the hook guards on.
 */
function installBridge(options: {
  result?: { ok: true; value: IncidentCountsDto } | { ok: false; error: string; code: string }
  reject?: boolean
  onCountsChangedThrows?: boolean
}): { push: (next: IncidentCountsDto) => void; calls: () => number } {
  let listener: PushListener | null = null
  let calls = 0
  const incidents = {
    counts: () => {
      calls += 1
      if (options.reject) {
        return Promise.reject(new Error('bridge unavailable'))
      }
      return Promise.resolve(options.result ?? { ok: true, value: countsFixture({ readAt: T0 }) })
    },
    onCountsChanged: (next: PushListener) => {
      if (options.onCountsChangedThrows) {
        throw new Error('no subscription here')
      }
      listener = next
      return () => {
        listener = null
      }
    }
  }
  ;(window as unknown as { api: unknown }).api = { incidents }
  return {
    push: (next) => {
      listener?.(next)
    },
    calls: () => calls
  }
}

async function settle(): Promise<void> {
  // The pull goes through the read adapter (one hop to the bridge, then the hook's own `then`), so it
  // needs a few microtask flushes rather than one; the assertions are about state, not about depth.
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  ;(window as unknown as { api: unknown }).api = undefined
})

afterEach(() => {
  vi.useRealTimers()
  ;(window as unknown as { api: unknown }).api = undefined
})

describe('useIncidentCounts availability', () => {
  it('starts idle and stays idle until a reading arrives', async () => {
    // A bridge that never answers yet: the first paint must not accuse the store.
    installBridge({ result: { ok: true, value: countsFixture({ readAt: T0 }) } })
    const { result } = renderHook(() => useIncidentCounts())
    expect(result.current).toEqual<IncidentCountsState>({ counts: null, availability: 'idle' })
  })

  it('reports a closed failure as unavailable, not as an empty store', async () => {
    installBridge({
      result: { ok: false, error: 'store unavailable', code: 'incident_store_unavailable' }
    })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current.counts).toBeNull()
    expect(result.current.availability).toBe('unavailable')
  })

  it('reports a rejected pull as unavailable', async () => {
    installBridge({ reject: true })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current).toMatchObject({ counts: null, availability: 'unavailable' })
  })

  it('reports a window with no incident bridge as unavailable', async () => {
    // A renderer that cannot ask at all is the clearest "no data" case there is.
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current).toMatchObject({ counts: null, availability: 'unavailable' })
  })

  it('goes ok on a reading, stale once the window passes, and ok again on the next push', async () => {
    const push = installBridge({
      result: { ok: true, value: countsFixture({ readAt: T0 }) }
    })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current.availability).toBe('ok')

    // One millisecond before the deadline: still citable. (The timer is armed from `readAt`, not from
    // mount, so the boundary is exact rather than approximate.)
    await act(async () => {
      vi.advanceTimersByTime(INCIDENT_COUNTS_STALE_MS - 1)
    })
    expect(result.current.availability).toBe('ok')

    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toMatchObject({ availability: 'stale' })

    // A push is a fresh reading: the marker must clear immediately, not on the next deadline.
    await act(async () => {
      push.push(countsFixture({ readAt: T0 + INCIDENT_COUNTS_STALE_MS, untriaged: 5 }))
    })
    expect(result.current.availability).toBe('ok')
    expect(result.current.counts?.untriaged).toBe(5)
  })

  it('re-arms the deadline for each reading instead of keeping the first one', async () => {
    const push = installBridge({
      result: { ok: true, value: countsFixture({ readAt: T0 }) }
    })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()

    await act(async () => {
      vi.advanceTimersByTime(INCIDENT_COUNTS_STALE_MS / 2)
    })
    await act(async () => {
      push.push(countsFixture({ readAt: T0 + INCIDENT_COUNTS_STALE_MS / 2 }))
    })
    // The first deadline would have fired at T0 + window; the reading moved, so it must not.
    await act(async () => {
      vi.advanceTimersByTime(INCIDENT_COUNTS_STALE_MS / 2 + 1)
    })
    expect(result.current.availability).toBe('ok')
  })

  it('treats a reading that arrives already older than the window as stale', async () => {
    // The pull happens after a long sleep/resume: `readAt` is already past its citable age.
    installBridge({
      result: { ok: true, value: countsFixture({ readAt: T0 - INCIDENT_COUNTS_STALE_MS - 1 }) }
    })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current).toMatchObject({ availability: 'stale' })
  })

  it('does not let a slow pull overwrite newer pushed counts', async () => {
    // The pull is deliberately still in flight when the push lands: the push carries a newer
    // `readAt`, so the pull's older payload must be dropped by the `newer()` guard instead of
    // overwriting it. (The previous body resolved the pull with the newer value and asserted it,
    // so it passed whether or not a push was ever involved.)
    let resolvePull: ((value: { ok: true; value: IncidentCountsDto }) => void) | null = null
    let listener: PushListener | null = null
    const incidents = {
      counts: () =>
        new Promise((resolve) => {
          resolvePull = resolve as typeof resolvePull
        }),
      onCountsChanged: (next: PushListener) => {
        listener = next
        return () => {
          listener = null
        }
      }
    }
    ;(window as unknown as { api: unknown }).api = { incidents }
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current.availability).toBe('idle')

    await act(async () => {
      listener?.(countsFixture({ readAt: T0 + 5_000, untriaged: 9 }))
    })
    expect(result.current.counts?.untriaged).toBe(9)

    // The pull resolves last but with an OLDER reading: it loses, and the pushed value stays.
    await act(async () => {
      resolvePull?.({ ok: true, value: countsFixture({ readAt: T0 + 1_000, untriaged: 1 }) })
    })
    await settle()
    expect(result.current.counts?.untriaged).toBe(9)
    expect(result.current.counts?.readAt).toBe(T0 + 5_000)
    expect(result.current.availability).toBe('ok')
  })

  it('still reads once when the push subscription is unavailable', async () => {
    // A bridge that cannot subscribe can still read: the pull decides the state.
    const bridge = installBridge({
      result: { ok: true, value: countsFixture({ readAt: T0 }) },
      onCountsChangedThrows: true
    })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(bridge.calls()).toBe(1)
    expect(result.current.availability).toBe('ok')
  })
})
