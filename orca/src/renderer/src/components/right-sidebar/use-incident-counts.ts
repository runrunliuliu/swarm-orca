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
import { readIncidentCounts } from '../../runtime/incident-read-client'
import type { IncidentRuntimeTarget } from '../../runtime/incident-runtime-target'
import { useIncidentRuntimeTarget } from '../../hooks/use-incident-runtime-target'
import type { IncidentCountsAvailability, IncidentCountsState } from './incident-counts-state'

export type { IncidentCountsAvailability, IncidentCountsState } from './incident-counts-state'

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
 * The comparison uses host `readAt` against the renderer clock; remote clock skew can affect staleness.
 */
export const INCIDENT_COUNTS_STALE_MS = 10 * 60 * 1000

function newer(current: IncidentCountsDto | null, next: IncidentCountsDto): IncidentCountsDto {
  return current === null || next.readAt >= current.readAt ? next : current
}

export function useIncidentCounts(): IncidentCountsState {
  // Why the selection is part of the key: the badge must count the host the panel is showing, and a
  // switch must invalidate the previous host's number instead of leaving it on screen.
  const target = useIncidentRuntimeTarget()
  // Kept separate from `counts` on purpose: "the read failed" must survive a failure that carries no
  // payload, and must clear the moment a reading (pull or push) actually arrives.
  const [reading, setReading] = useState<{
    target: IncidentRuntimeTarget
    counts: IncidentCountsDto | null
    failed: boolean
  }>({ target, counts: null, failed: false })
  const counts = reading.target === target ? reading.counts : null
  const failed = reading.target === target && reading.failed
  const [staleReading, setStaleReading] = useState<IncidentCountsDto | null>(null)

  useEffect(() => {
    const accept = (next: IncidentCountsDto): void => {
      setReading((current) => ({
        target,
        // Host clocks are incomparable; only order readings from the same target.
        counts: newer(current.target === target ? current.counts : null, next),
        failed: false
      }))
    }
    let live = true
    let unsubscribe: (() => void) | null = null
    // The pull goes through the runtime the panel is showing (local or a paired environment). The push
    // below stays local-only on purpose: `incidents:countsChanged` is a main-process broadcast, so a
    // remote host's writes reach us on the next bounded pull, not as a live push.
    const subscribeLocalPush = (current: IncidentRuntimeTarget): (() => void) | null => {
      if (current.kind !== 'local') {
        return null
      }
      const incidents = window.api?.incidents
      if (!incidents || typeof incidents.onCountsChanged !== 'function') {
        return null
      }
      try {
        return incidents.onCountsChanged((next) => {
          if (live) {
            accept(next)
          }
        })
      } catch {
        return null
      }
    }
    unsubscribe = subscribeLocalPush(target)
    void readIncidentCounts(target)
      .then((outcome) => {
        if (!live) {
          return
        }
        if (outcome.availability === 'supported') {
          accept(outcome.value)
        } else {
          // `unsupported` and `unavailable` are both a stated absence, never a zero: the badge draws
          // its marker and the panel says why.
          setReading({ target, counts: null, failed: true })
        }
      })
      .catch(() => {
        if (live) {
          setReading({ target, counts: null, failed: true })
        }
      })
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [target])

  // Arm the staleness deadline for the newest reading; a new push replaces it (and clears the flag).
  useEffect(() => {
    if (counts === null) {
      return
    }
    const remaining = counts.readAt + INCIDENT_COUNTS_STALE_MS - Date.now()
    if (remaining <= 0) {
      setStaleReading(counts)
      return
    }
    const timer = setTimeout(() => setStaleReading(counts), remaining)
    return () => clearTimeout(timer)
  }, [counts])

  const availability: IncidentCountsAvailability =
    counts !== null ? (staleReading === counts ? 'stale' : 'ok') : failed ? 'unavailable' : 'idle'
  return { counts, availability }
}
