// `orca incident digest`: the numbers a daily review needs (issue-sedimentation.md v2.5 §10, M4-2).
//
// Read-only and derived: every figure is one SQL aggregate over the incidents database, so the digest
// cannot drift from the store the way a separately maintained summary would. It deliberately has no
// mining, no triage and no writes — §10 puts those behind later milestones and human authorisation.
//
// `unseen` is defined as "effective status is still untriaged": the store has no per-actor read marker,
// and inventing one here would be a second source of truth. `dropped` and the replay state come from
// the shadow coverage the replay already publishes.

import type Database from '../sqlite/sync-database'
import type { IncidentClass, IncidentCoverage, IncidentStatus } from './incident-types'
import { readToolErrorWindows } from './incident-tool-error-observer'

export const DEFAULT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000
const TOP_FINGERPRINTS = 5

export type IncidentDigest = {
  since: number
  windowMs: number
  total: number
  byClass: { class: IncidentClass; count: number }[]
  byStatus: { status: IncidentStatus; count: number }[]
  topFingerprints: { fingerprint: string; count: number }[]
  unseen: number
  dropped: number
  shadowReplay: {
    lastSeq: number
    incomplete: boolean
    lastStopReason: string | null
    failures: number
    lastError: string | null
    lastRun: { lines: number; bytes: number; ms: number } | null
  }
  capacity: {
    rows: number
    bytes: number
    maxRows: number
    maxBytes: number
    capacityLatchSet: boolean
    currentlyLimited: boolean
  }
  toolError: {
    /** Windows currently counted on this host; a read of the last published snapshot. */
    windows: number
    wouldWrite: number
    writeEnabled: boolean
    updatedAt: number | null
  }
}

/** Parse `24h` / `7d` / `90m` / `3600s`; returns null for anything unrecognised. */
export function parseDigestWindow(value: string): number | null {
  const match = /^(\d{1,5})([smhd])$/.exec(value.trim())
  if (!match) {
    return null
  }
  const amount = Number(match[1])
  const unit = match[2]
  const unitMs = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return amount * unitMs
}

export function buildIncidentDigest(
  db: Database.Database,
  options: { now: number; windowMs?: number; coverage: IncidentCoverage }
): IncidentDigest {
  const windowMs = options.windowMs ?? DEFAULT_DIGEST_WINDOW_MS
  const since = options.now - windowMs
  const rows = db
    .prepare(
      `SELECT i.class AS class, s.status AS status, i.fingerprint AS fingerprint, i.created_at AS created_at
       FROM incidents i JOIN incident_state s ON s.incident_id = i.id
       WHERE i.created_at >= ?`
    )
    .all(since) as { class: string; status: string; fingerprint: string; created_at: number }[]

  const byClass = new Map<string, number>()
  const byStatus = new Map<string, number>()
  const byFingerprint = new Map<string, number>()
  let unseen = 0
  for (const row of rows) {
    byClass.set(row.class, (byClass.get(row.class) ?? 0) + 1)
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1)
    byFingerprint.set(row.fingerprint, (byFingerprint.get(row.fingerprint) ?? 0) + 1)
    if (row.status === 'untriaged') {
      unseen += 1
    }
  }

  // Coverage is the store's own report (limits, itch, replay state, drops): the digest quotes it
  // rather than recomputing a second, potentially disagreeing, set of numbers.
  const { shadowReplay: shadow, capacity: capacityCoverage } = options.coverage
  const toolWindows = readToolErrorWindows(db)
  const rowsTotal = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM incidents').get() as { n?: number } | undefined)?.n ?? 0
  )

  return {
    since,
    windowMs,
    total: rows.length,
    byClass: [...byClass.entries()]
      .map(([value, count]) => ({ class: value as IncidentClass, count }))
      .sort((left, right) => right.count - left.count || left.class.localeCompare(right.class)),
    byStatus: [...byStatus.entries()]
      .map(([value, count]) => ({ status: value as IncidentStatus, count }))
      .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status)),
    topFingerprints: [...byFingerprint.entries()]
      .map(([fingerprint, count]) => ({ fingerprint, count }))
      .sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint))
      .slice(0, TOP_FINGERPRINTS),
    unseen,
    dropped: shadow.dropped,
    shadowReplay: {
      lastSeq: shadow.lastSeq,
      incomplete: shadow.incomplete,
      lastStopReason: shadow.lastStopReason,
      failures: shadow.failures,
      lastError: shadow.lastError,
      lastRun: shadow.lastRun
    },
    capacity: {
      rows: rowsTotal,
      bytes: capacityCoverage.bytes,
      maxRows: capacityCoverage.maxRows,
      maxBytes: capacityCoverage.maxBytes,
      capacityLatchSet: options.coverage.capacityLatchSet,
      currentlyLimited: options.coverage.currentlyLimited
    },
    toolError: {
      windows: toolWindows.windows.length,
      wouldWrite: toolWindows.windows.filter((window) => window.wouldWriteIfEnabled).length,
      writeEnabled: toolWindows.writeEnabled,
      updatedAt: toolWindows.updatedAt
    }
  }
}
