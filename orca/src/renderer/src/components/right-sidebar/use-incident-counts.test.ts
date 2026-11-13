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
import {
  INCIDENT_COUNTS_STALE_MS,
  useIncidentCounts,
  type IncidentCountsState
} from './use-incident-counts'

const T0 = 1_700_000_000_000

function counts(readAt: number, overrides: Partial<IncidentCountsDto> = {}): IncidentCountsDto {
  return {
    untriaged: 2,
    total: 3,
    byClass: {
      crash: 2,
      no_progress: 0,
      tool_error: 0,
      acceptance_failed: 0,
      acceptance_overridden: 0,
      unknown_state: 0
    },
    byWorktree: [{ worktreeId: 'wt-1', untriaged: 2 }],
    coverage: {
      currentlyLimited: false,
      capacityLatchSet: false,
      shadowReplayIncomplete: false,
      shadowReplayDropped: 0,
      remoteIncidentCapture: 'unsupported',
      gap: false
    },
    readAt,
    ...overrides
  }
}

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
      return Promise.resolve(options.result ?? { ok: true, value: counts(T0) })
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
  // The pull resolves on a microtask; a couple of flushes turn it into committed state.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
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
    installBridge({ result: { ok: true, value: counts(T0) } })
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
    const push = installBridge({ result: { ok: true, value: counts(T0) } })
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
      push.push(counts(T0 + INCIDENT_COUNTS_STALE_MS, { untriaged: 5 }))
    })
    expect(result.current.availability).toBe('ok')
    expect(result.current.counts?.untriaged).toBe(5)
  })

  it('re-arms the deadline for each reading instead of keeping the first one', async () => {
    const push = installBridge({ result: { ok: true, value: counts(T0) } })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()

    await act(async () => {
      vi.advanceTimersByTime(INCIDENT_COUNTS_STALE_MS / 2)
    })
    await act(async () => {
      push.push(counts(T0 + INCIDENT_COUNTS_STALE_MS / 2))
    })
    // The first deadline would have fired at T0 + window; the reading moved, so it must not.
    await act(async () => {
      vi.advanceTimersByTime(INCIDENT_COUNTS_STALE_MS / 2 + 1)
    })
    expect(result.current.availability).toBe('ok')
  })

  it('treats a reading that arrives already older than the window as stale', async () => {
    // The pull happens after a long sleep/resume: `readAt` is already past its citable age.
    installBridge({ result: { ok: true, value: counts(T0 - INCIDENT_COUNTS_STALE_MS - 1) } })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current).toMatchObject({ availability: 'stale' })
  })

  it('does not let a slow pull overwrite newer pushed counts', async () => {
    // Same rule the hook always had, kept while the state shape changed.
    let resolvePull: ((value: { ok: true; value: IncidentCountsDto }) => void) | null = null
    const incidents = {
      counts: () =>
        new Promise((resolve) => {
          resolvePull = resolve as typeof resolvePull
        }),
      onCountsChanged: () => () => {}
    }
    ;(window as unknown as { api: unknown }).api = { incidents }
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(result.current.availability).toBe('idle')

    await act(async () => {
      resolvePull?.({ ok: true, value: counts(T0 + 5_000, { untriaged: 9 }) })
    })
    await settle()
    expect(result.current.counts?.untriaged).toBe(9)
  })

  it('still reads once when the push subscription is unavailable', async () => {
    // A bridge that cannot subscribe can still read: the pull decides the state.
    const bridge = installBridge({
      result: { ok: true, value: counts(T0) },
      onCountsChangedThrows: true
    })
    const { result } = renderHook(() => useIncidentCounts())
    await settle()
    expect(bridge.calls()).toBe(1)
    expect(result.current.availability).toBe('ok')
  })
})
