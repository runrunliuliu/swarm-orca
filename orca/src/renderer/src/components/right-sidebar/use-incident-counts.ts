// Pull the incident counts once, then follow the main-process push (§12, M7-A; availability M7-D).
//
// The push is already coalesced upstream (`main/ipc/incident-counts-push.ts`), so this hook keeps no
// debounce of its own: a second set of windows here would only give us a second set to reason about.
// It does keep ONE deadline, and it is not a poll: the staleness expiry below fires once per reading.
//
// Four honesty rules:
//   * an unavailable store is not "0 untriaged" — it stays a *stated* absence (`availability:
//     'unavailable'`), never a reassuring zero over an unreadable store;
//   * a reading is not eternal — past `INCIDENT_COUNTS_STALE_MS` it is reported as `'stale'` instead of
//     continuing to look current;
//   * "nothing has arrived yet" (`'idle'`) is a different fact from "the read failed": only the second
//     one may draw the unavailable marker, so a first paint is not an error state;
//   * a pull that resolves after the first push must not overwrite newer counts, so the newer `readAt`
//     wins either way.
//
// Why `'stale'` needs a timer at all: `readAt` is stamped by the main process, and the push only fires
// on a store write. A host with no writes therefore sends nothing, so without a deadline the reader
// could not tell "quiet" from "the write path stopped talking to us" (§11.5: missing evidence is not a
// quiet week). The timer is the *only* clock in this hook: it is armed once per reading, at the moment
// that reading expires, and disposed with the reading.

import { useEffect, useState } from 'react'
import type { IncidentCountsDto } from '../../../../shared/incident-api-types'

/**
 * How long a reading stays citable, measured from its own `readAt`.
 *
 * 10 minutes, and deliberately not a multiple of the push's coalescing windows (100 ms quiet window,
 * 500 ms starvation cap, `main/ipc/incident-counts-push.ts`): those bound how long a *burst* is held,
 * not how often a healthy idle host publishes. Nothing is pushed while nothing is written, so a small
 * threshold would mark every quiet machine stale within seconds and turn the marker into furniture.
 * Ten minutes is long past any plausible push latency (≈1200× the starvation cap) and short enough
 * that a writer that died while the user was away is still visible in the same session.
 *
 * The comparison uses `readAt` against the renderer clock. Both run on this host (Electron main stamps
 * `Date.now()`, the renderer reads it), so there is no clock-skew assumption to document — only that a
 * renderer running on a different machine is not a supported shape today.
 */
export const INCIDENT_COUNTS_STALE_MS = 10 * 60 * 1000

/**
 * `idle` = nothing has arrived yet and nothing has failed (first paint: draw nothing).
 * `ok` = a reading arrived and is still fresh.
 * `stale` = a reading arrived but is older than `INCIDENT_COUNTS_STALE_MS`.
 * `unavailable` = the read failed, or this window has no incident bridge, so there is no reading at all.
 */
export type IncidentCountsAvailability = 'idle' | 'ok' | 'stale' | 'unavailable'

export type IncidentCountsState = {
  counts: IncidentCountsDto | null
  availability: IncidentCountsAvailability
}

function newer(
  current: IncidentCountsDto | null,
  next: IncidentCountsDto
): IncidentCountsDto {
  return current === null || next.readAt >= current.readAt ? next : current
}

export function useIncidentCounts(): IncidentCountsState {
  const [counts, setCounts] = useState<IncidentCountsDto | null>(null)
  // Kept separate from `counts` on purpose: "the read failed" must survive a failure that carries no
  // payload, and must clear the moment a reading (pull or push) actually arrives.
  const [failed, setFailed] = useState(false)
  const [stale, setStale] = useState(false)

  const accept = (next: IncidentCountsDto): void => {
    setCounts((current) => newer(current, next))
    setFailed(false)
  }

  useEffect(() => {
    let live = true
    let unsubscribe: (() => void) | null = null
    // One guarded access for both calls: a renderer without the incident bridge (paired web client,
    // or a component test that mocks a partial `window.api`) must still render, but it must say the
    // count is unavailable rather than imply the store is empty.
    const api = (() => {
      const incidents = window.api?.incidents
      return incidents && typeof incidents.counts === 'function' ? incidents : null
    })()
    if (api === null) {
      setFailed(true)
      return
    }
    try {
      unsubscribe = api.onCountsChanged((next) => {
        if (live) {
          accept(next)
        }
      })
    } catch {
      // A bridge that cannot subscribe is still a bridge that can read: the pull below decides.
      unsubscribe = null
    }
    void api
      .counts()
      .then((result) => {
        if (!live) {
          return
        }
        if (result.ok) {
          accept(result.value)
        } else {
          // A closed failure (no store on this host yet, store unavailable) is a stated absence — not
          // an empty store. The marker says "unavailable"; it never draws a zero.
          setFailed(true)
        }
      })
      .catch(() => {
        if (live) {
          setFailed(true)
        }
      })
    return () => {
      live = false
      unsubscribe?.()
    }
    // Mount-only on purpose: the counts are host-global, so no store field can change the answer and
    // re-subscribing on every state write would churn listeners for no new information.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Arm the staleness deadline for the newest reading; a new push replaces it (and clears the flag).
  useEffect(() => {
    if (counts === null) {
      setStale(false)
      return
    }
    const remaining = counts.readAt + INCIDENT_COUNTS_STALE_MS - Date.now()
    if (remaining <= 0) {
      setStale(true)
      return
    }
    setStale(false)
    const timer = setTimeout(() => setStale(true), remaining)
    return () => clearTimeout(timer)
  }, [counts])

  const availability: IncidentCountsAvailability =
    counts !== null ? (stale ? 'stale' : 'ok') : failed ? 'unavailable' : 'idle'
  return { counts, availability }
}
