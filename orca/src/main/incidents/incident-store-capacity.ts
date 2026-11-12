// Capacity and its latch (§11.5).
//
// Two numbers decide whether the store keeps accepting noise: rows and bytes. The latch is the third
// fact — "this store refused writes" is history a triage session needs even after a prune brings the
// count back down, and a store that silently stopped recording must never look like a quiet week.

import type Database from '../sqlite/sync-database'
import type { IncidentCoverage } from './incident-types'
import type { IncidentStoreLimits } from './incident-store-contract'
import { readShadowReplayCoverage } from './incident-shadow-coverage'

const META_TABLE = 'incident_store_meta'
const CAPACITY_LATCH_KEY = 'capacity_limited'

export type CapacityState = {
  rows: number
  bytes: number
  limitedBy: 'rows' | 'bytes' | null
}

export type CapacityGate = {
  state: () => CapacityState
  coverage: () => IncidentCoverage
  /** Persist the "we refused a write" latch; called by the insert path, in its own transaction. */
  latch: () => void
}

export function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(key)
  return row ? String(row.value) : null
}

export function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ` +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export function createCapacityGate(options: {
  db: Database.Database
  limits: IncidentStoreLimits
  fileSizeBytes: () => number
  /** Runs the latch write in its own transaction so a full store still records that it is full. */
  runImmediate: <T>(run: () => T) => T
}): CapacityGate {
  const { db, limits, fileSizeBytes, runImmediate } = options

  function countRows(): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM incidents').get()
    return row ? Number(row.n ?? 0) : 0
  }

  function state(): CapacityState {
    const rows = countRows()
    const bytes = fileSizeBytes()
    if (rows >= limits.maxRows) {
      return { rows, bytes, limitedBy: 'rows' }
    }
    if (bytes >= limits.maxBytes) {
      return { rows, bytes, limitedBy: 'bytes' }
    }
    return { rows, bytes, limitedBy: null }
  }

  function coverage(): IncidentCoverage {
    const current = state()
    return {
      remoteIncidentCapture: 'unsupported',
      // Past tense: the latch survives a prune, so it must not be printed as a live refusal.
      capacityLatchSet: readMeta(db, CAPACITY_LATCH_KEY) === '1',
      currentlyLimited: current.limitedBy !== null,
      capacity: {
        rows: current.rows,
        bytes: current.bytes,
        maxRows: limits.maxRows,
        maxBytes: limits.maxBytes
      },
      shadowReplay: readShadowReplayCoverage(db)
    }
  }

  function latch(): void {
    runImmediate(() => writeMeta(db, CAPACITY_LATCH_KEY, '1'))
  }

  return { state, coverage, latch }
}
