// Capacity and its latch (§11.5).
//
// Two numbers decide whether the store keeps accepting noise: rows and bytes. The latch is the third
// fact — "this store refused writes" is history a triage session needs even after a prune brings the
// count back down, and a store that silently stopped recording must never look like a quiet week.

import type Database from '../sqlite/sync-database'
import type { IncidentCoverage } from './incident-types'
import type { IncidentStoreLimits } from './incident-store-contract'
import { readShadowReplayCoverage } from './incident-shadow-coverage'
import { readMeta, writeMeta } from './incident-store-meta'
import { readPaneClockCoverage } from './incident-pane-clocks'

const CAPACITY_LATCH_KEY = 'capacity_limited'

export type CapacityState = {
  rows: number
  bytes: number
  limitedBy: 'rows' | 'bytes' | null
}

/**
 * One capacity reading reused across a batch of inserts (A1).
 *
 * A batch writer — the shadow replay (up to 20,000 lines per start) and the mirror pull (per page) —
 * used to pay `COUNT(*)` + three `stat` calls *per row*. It now takes one real reading when the batch
 * opens and counts what it admits itself: the row cap is then exact (the reading plus this batch's
 * own admissions), and only the byte cap can drift, because file size grows without a `stat`.
 * `endCapacityBatch` pays one real reading at the end, so a batch cannot hold a stale verdict for
 * longer than itself.
 */
export type CapacityBatch = {
  /** The real reading taken when the batch opened. */
  readonly state: CapacityState
  /** Rows this batch has admitted since that reading, crash rows included (they consume a row). */
  admitted: number
}

export type CapacityGate = {
  state: () => CapacityState
  /** Take the one real reading a batch writer reuses; see `CapacityBatch`. */
  beginBatch: () => CapacityBatch
  /** The same decision as `state()`, from a batch's opening reading plus its own admissions. */
  batchState: (batch: CapacityBatch) => CapacityState
  /**
   * One real reading at the end of a batch; latches when the batch finished over a limit.
   *
   * The batch is taken and ignored on purpose: `batch.admitted` is the writer's own arithmetic, and
   * the whole point of this call is that the latch is decided by a fresh reading, not by it. Requiring
   * the parameter still makes the compiler notice a writer that closes a batch it never opened.
   */
  endBatch: (_batch: CapacityBatch) => CapacityState
  coverage: () => IncidentCoverage
  /** Persist the "we refused a write" latch; called by the insert path, in its own transaction. */
  latch: () => void
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

  function decide(rows: number, bytes: number): CapacityState {
    if (rows >= limits.maxRows) {
      return { rows, bytes, limitedBy: 'rows' }
    }
    if (bytes >= limits.maxBytes) {
      return { rows, bytes, limitedBy: 'bytes' }
    }
    return { rows, bytes, limitedBy: null }
  }

  function state(): CapacityState {
    return decide(countRows(), fileSizeBytes())
  }

  function beginBatch(): CapacityBatch {
    return { state: state(), admitted: 0 }
  }

  function batchState(batch: CapacityBatch): CapacityState {
    // Only the rows move with an insert; bytes are re-read once, in `endBatch`.
    return decide(batch.state.rows + batch.admitted, batch.state.bytes)
  }

  function endBatch(_batch: CapacityBatch): CapacityState {
    const current = state()
    if (current.limitedBy !== null) {
      latch()
    }
    return current
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
      shadowReplay: readShadowReplayCoverage(db),
      paneClock: readPaneClockCoverage(db)
    }
  }

  function latch(): void {
    runImmediate(() => writeMeta(db, CAPACITY_LATCH_KEY, '1'))
  }

  return { state, beginBatch, batchState, endBatch, coverage, latch }
}
