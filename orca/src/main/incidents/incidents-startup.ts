// The single startup mount point for the incident shadow replay (issue-sedimentation.md v2.3 §11.2, §14).
//
// `initializeReadyFoundation` calls `scheduleIncidentShadowReconcile` exactly once. Everything that
// can fail lives here, and none of it may gate the window: reconcile is deferred one turn, and every
// failure becomes one log line plus a counter in the store — never an exception, never silence.
//
// Why a retry of the store open happens here: §12 records that M1 caches a failed open for the life
// of the process. A user who fixes the directory should not need a restart *and* the replay; this is
// the natural moment to try again, because it is also the moment the replay needs the store.

import { closeIncidentShadowSink } from './incident-shadow'
import {
  reconcileIncidentShadow,
  recordShadowReconcileFailure,
  type ShadowReconcileSummary
} from './incident-shadow-reconcile'
import { incidentRuntimeStore, resetIncidentStoreCache } from './incident-writer'
import { mainProcessUserDataPath } from './incidents-paths'

export type IncidentShadowStartupResult = {
  ran: boolean
  reason?: 'no_user_data_path' | 'store_unavailable' | 'already_reconciled'
  summary?: ShadowReconcileSummary
  error?: string
}

let reconciled = false

/**
 * Replay the shadow once per process.
 *
 * Synchronous and testable: the caller decides when it runs. Production schedules it through
 * `scheduleIncidentShadowReconcile` so a large shadow cannot delay the first window.
 */
export function reconcileIncidentShadowAtStartup(options: {
  userDataPath?: string | null
} = {}): IncidentShadowStartupResult {
  if (reconciled) {
    return { ran: false, reason: 'already_reconciled' }
  }
  // Attempt-once semantics: startup runs one turn, and a failure here is reported rather than
  // retried every later turn. A new process is the retry.
  reconciled = true
  const userDataPath =
    options.userDataPath === undefined ? mainProcessUserDataPath() : options.userDataPath
  if (userDataPath === null || userDataPath.length === 0) {
    console.warn('[incidents] shadow replay skipped: no user-data path is available yet')
    return { ran: false, reason: 'no_user_data_path' }
  }
  // Flush first: the sink's buffered tail belongs in the file before we read the file family.
  closeIncidentShadowSink()
  resetIncidentStoreCache()
  const runtime = incidentRuntimeStore()
  if (runtime === null) {
    const message = 'shadow replay skipped: incident store is unavailable'
    console.warn(`[incidents] ${message}`)
    return { ran: false, reason: 'store_unavailable', error: message }
  }
  try {
    const summary = reconcileIncidentShadow({
      store: runtime.store,
      db: runtime.db,
      userDataPath
    })
    if (summary.stopped !== null) {
      // A torn tail after a crash is expected, not a defect — but it is the reason the replay
      // stopped, so it is stated once instead of looking like a complete pass.
      console.warn(
        `[incidents] shadow replay stopped at ${summary.stopped.file}@seq${summary.stopped.lastSeq} ` +
          `(${summary.stopped.reason}${summary.stopped.detail ? `: ${summary.stopped.detail}` : ''}); ` +
          `replayed ${summary.replayed} of ${summary.files} file(s)`
      )
    } else if (summary.replayed > 0) {
      console.log(
        `[incidents] shadow replay: ${summary.inserted} new, ${summary.duplicates} already known`
      )
    }
    return { ran: true, summary }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'shadow_replay_failed'
    recordShadowReconcileFailure(runtime.db, message)
    console.warn('[incidents] shadow replay failed:', message)
    return { ran: true, error: message }
  }
}

/**
 * Production entry: one deferred turn, never on the startup critical path.
 *
 * `setImmediate` and not a timer: a single scheduling hop, no interval, nothing to cancel. A shadow
 * that grew to ~100MB would otherwise be parsed between `app.ready` and the first window.
 */
export function scheduleIncidentShadowReconcile(userDataPath?: string | null): void {
  setImmediate(() => {
    try {
      reconcileIncidentShadowAtStartup({ userDataPath })
    } catch (error) {
      // Belt and braces: the function above already reports, but a throw here would be unhandled.
      console.warn(
        '[incidents] shadow replay scheduling failed:',
        error instanceof Error ? error.name : 'unknown'
      )
    }
  })
}

export function __resetIncidentShadowStartupForTests(): void {
  reconciled = false
  closeIncidentShadowSink()
}
