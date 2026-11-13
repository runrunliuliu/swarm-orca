// The single startup mount point for the incident shadow replay and the remote mirror
// (issue-sedimentation.md v2.3 §11.2, §14; remote mirror §11.1, M7-C).
//
// `initializeReadyFoundation` calls `scheduleIncidentShadowReconcile` exactly once. Everything that
// can fail lives here, and none of it may gate the window: reconcile is deferred one turn, and every
// failure becomes one log line plus a counter in the store — never an exception, never silence.
//
// The remote mirror runs in the same deferred turn, after the shadow. It is *not* on the path that
// records local facts: it pulls from origin hosts this process was handed a feed for (today: none, so
// it returns `no_feeds` without opening the store or a connection). A reconnect calls
// `syncIncidentMirror` directly — the startup guard is once-per-process, the pull itself is not.
//
// Why a retry of the store open happens here: §12 records that M1 caches a failed open for the life
// of the process. A user who fixes the directory should not need a restart *and* the replay; this is
// the natural moment to try again, because it is also the moment the replay needs the store.

import {
  listMirrorFeeds,
  syncIncidentMirror,
  type MirrorSyncSummary
} from './incident-mirror-sync'
import { closeIncidentShadowSink } from './incident-shadow'
import {
  reconcileIncidentShadow,
  recordShadowReconcileFailure,
  type ShadowReconcileSummary
} from './incident-shadow-reconcile'
import { incidentRuntimeStore, resetIncidentStoreCache } from './incident-writer'
import { startEvidenceArchiveDrain, stopEvidenceArchiveDrain } from './incident-archive'
import { mainProcessUserDataPath } from './incidents-paths'

export type IncidentShadowStartupResult = {
  ran: boolean
  reason?: 'no_user_data_path' | 'store_unavailable' | 'already_reconciled'
  summary?: ShadowReconcileSummary
  error?: string
}

let reconciled = false
let mirrored = false

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

export type IncidentMirrorStartupResult = {
  ran: boolean
  reason?: 'no_user_data_path' | 'no_feeds' | 'store_unavailable' | 'already_synced'
  summary?: MirrorSyncSummary
  error?: string
}

/**
 * Pull every registered origin once, at startup.
 *
 * Order matters for honesty: with no feed registered this returns `no_feeds` BEFORE touching the
 * store, so a host that mirrors nothing never creates an incidents database or a directory just
 * because it started. The read model answers `unsupported` in that state, which is the truth.
 */
export async function syncIncidentMirrorAtStartup(
  options: { userDataPath?: string | null } = {}
): Promise<IncidentMirrorStartupResult> {
  if (mirrored) {
    return { ran: false, reason: 'already_synced' }
  }
  mirrored = true
  const feeds = listMirrorFeeds()
  if (feeds.length === 0) {
    return { ran: false, reason: 'no_feeds' }
  }
  const userDataPath =
    options.userDataPath === undefined ? mainProcessUserDataPath() : options.userDataPath
  if (userDataPath === null || userDataPath.length === 0) {
    console.warn('[incidents] remote mirror skipped: no user-data path is available yet')
    return { ran: false, reason: 'no_user_data_path' }
  }
  const runtime = incidentRuntimeStore()
  if (runtime === null) {
    const message = 'remote mirror skipped: incident store is unavailable'
    console.warn(`[incidents] ${message}`)
    return { ran: false, reason: 'store_unavailable', error: message }
  }
  try {
    const summary = await syncIncidentMirror({ store: runtime.store, db: runtime.db, feeds })
    for (const host of summary.hosts) {
      if (host.error !== null) {
        // One line per failing host: the link row already carries it, but a reader of the log must
        // not have to open SQLite to learn that a mirror is down.
        console.warn(`[incidents] mirror ${host.hostId} stopped: ${host.error}`)
      }
    }
    if (summary.inserted > 0) {
      console.log(
        `[incidents] remote mirror: ${summary.inserted} new, ${summary.duplicates} already known`
      )
    }
    return { ran: true, summary }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'mirror_failed'
    console.warn('[incidents] remote mirror failed:', message)
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
    // After the shadow, not before: mirroring must never delay recording what this host observed.
    void syncIncidentMirrorAtStartup({ userDataPath }).catch((error: unknown) => {
      console.warn(
        '[incidents] mirror scheduling failed:',
        error instanceof Error ? error.name : 'unknown'
      )
    })
    // Evidence archive drain: an unref'd background interval. It is never awaited by PTY teardown or
    // settlement; without a configured archive root it is a no-op and the state stays `pending`.
    startEvidenceArchiveDrain()
  })
}

export function __resetIncidentShadowStartupForTests(): void {
  reconciled = false
  mirrored = false
  closeIncidentShadowSink()
  stopEvidenceArchiveDrain()
}
