// The renderer push for the activity-bar count (§12, M7-A).
//
// A store write is the trigger, but a burst of writes must not become a burst of IPC. PTY teardown in
// particular can insert several rows back to back (one per pane), and a shadow replay inserts one row
// per hint line — pushing per write would put dozens of count reads and window sends on the same path
// that has to survive a terminal teardown.
//
// So this reuses the same keyed trailing-edge coalescer as the session.tabs notify (one key, "counts"):
// a quiet window collapses a burst into one read+send, and the starvation cap keeps a permanently busy
// store from postponing the emit forever. The read happens *inside* the emit, so the payload is always
// the newest counts, never a stale one from the first write of the burst.
//
// Failure policy: the push is diagnostics chrome. A store that is not open yet, a read that throws and
// a window that is gone are all silent — none of them may fail the write that scheduled the push.

import type { IncidentCountsDto } from '../../shared/incident-api-types'
import { readIncidentCounts } from '../incidents/incident-counts'
import { onIncidentStoreChange } from '../incidents/incident-store-changes'
import { incidentRuntimeStoreIfPresent } from '../incidents/incident-writer'
import { attachIncidentRemoteMirrorToCounts } from './incident-mirror-coverage'
import {
  createKeyedTrailingEdgeCoalescer,
  type KeyedTrailingEdgeCoalescer
} from '../runtime/keyed-trailing-edge-coalescer'

/** One coalescing key: the counts are host-global, not per worktree. */
const COUNTS_KEY = 'counts'
/** Quiet window: a badge may lag a burst by this much; it must not send once per row. */
export const INCIDENT_COUNTS_FLUSH_MS = 100
/** Starvation cap: a store that never goes quiet still publishes within this window. */
export const INCIDENT_COUNTS_MAX_WAIT_MS = 500

export type IncidentCountsSender = (counts: IncidentCountsDto) => void

export type IncidentCountsPush = {
  /** Drop the subscription and any pending emit without firing it. */
  stop: () => void
  /** Fire a pending emit now (used by `incidents:counts` after an explicit read request). */
  flush: () => void
}

let active: { coalescer: KeyedTrailingEdgeCoalescer; unsubscribe: () => void } | null = null

/**
 * Start (or restart) the push. Idempotent: a second call replaces the previous subscription rather
 * than doubling every notification.
 */
export function startIncidentCountsPush(send: IncidentCountsSender): IncidentCountsPush {
  stopIncidentCountsPush()
  const coalescer = createKeyedTrailingEdgeCoalescer(
    () => {
      const counts = readCountsForPush()
      if (counts === null) {
        return
      }
      try {
        send(counts)
      } catch {
        // The window went away mid-flight; the next edit or the next app start re-reads the counts.
      }
    },
    { flushMs: INCIDENT_COUNTS_FLUSH_MS, maxWaitMs: INCIDENT_COUNTS_MAX_WAIT_MS }
  )
  const unsubscribe = onIncidentStoreChange(() => coalescer.schedule(COUNTS_KEY))
  active = { coalescer, unsubscribe }
  return {
    stop: stopIncidentCountsPush,
    flush: () => {
      if (active !== null) {
        active.coalescer.flushAll()
      }
    }
  }
}

export function stopIncidentCountsPush(): void {
  if (active !== null) {
    active.unsubscribe()
    active.coalescer.dispose()
    active = null
  }
}

/**
 * Read the counts for a push, or `null` when there is nothing to announce.
 *
 * Uses the "if present" resolver on purpose: a passive notification must not create the incidents
 * directory on a host that never wrote an incident. Absence means "no store", which is not "zero
 * incidents" — the renderer's own initial read reports availability.
 */
function readCountsForPush(): IncidentCountsDto | null {
  try {
    const runtime = incidentRuntimeStoreIfPresent()
    if (runtime === null) {
      return null
    }
    return attachIncidentRemoteMirrorToCounts(
      runtime.db,
      readIncidentCounts({ db: runtime.db, coverage: runtime.store.coverage() })
    )
  } catch {
    return null
  }
}

/** Test seam (house pattern): drop the subscription between cases. */
export function __resetIncidentCountsPushForTests(): void {
  stopIncidentCountsPush()
}
