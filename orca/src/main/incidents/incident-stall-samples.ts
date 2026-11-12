// Sample persistence + reads for the stall sampler (M3-3).
//
// Split out of the sampler so the sampling policy (thresholds, declarations, writes) and the two SQL
// statements stay readable, and so the CLI can read the last sample without importing the sampler's
// timer wiring.

import type Database from '../sqlite/sync-database'

/** One row of the last sample: what the sampler decided and what the CLI prints. */
export type StallSampleRow = {
  paneKey: string
  terminalHandle: string | null
  state: string
  stateStartedAt: number
  turnStartedAt: number | null
  /** `evidenceObservedAt` for this pane, or null when the host never reported one. */
  lastSemanticEventAt: number | null
  ageMs: number
  /** `event` when the age came from the semantic clock, `state_fallback` when it did not. */
  ageBasis: 'event' | 'state_fallback'
  thresholdMs: number
  /** Would a write-enabled sampler record this? Never means "confirmed stuck". */
  wouldWriteIfEnabled: boolean
  reason: string
  declaredWait: string | null
}

export function readStallSamples(db: Database.Database): StallSampleRow[] {
  const rows = db
    .prepare(
      `SELECT pane_key, terminal_handle, state, state_started_at, turn_started_at,
              last_semantic_event_at, age_ms, age_basis, threshold_ms, would_write_if_enabled,
              reason, declared_wait
       FROM incident_stall_samples ORDER BY pane_key ASC`
    )
    .all()
  return rows.map((row) => ({
    paneKey: String(row.pane_key),
    terminalHandle: row.terminal_handle === null ? null : String(row.terminal_handle),
    state: String(row.state),
    stateStartedAt: Number(row.state_started_at),
    turnStartedAt: row.turn_started_at === null ? null : Number(row.turn_started_at),
    lastSemanticEventAt:
      row.last_semantic_event_at === null ? null : Number(row.last_semantic_event_at),
    ageMs: Number(row.age_ms),
    ageBasis: row.age_basis === 'event' ? 'event' : 'state_fallback',
    thresholdMs: Number(row.threshold_ms),
    wouldWriteIfEnabled: Number(row.would_write_if_enabled) === 1,
    reason: String(row.reason),
    declaredWait: row.declared_wait === null ? null : String(row.declared_wait)
  }))
}


/**
 * Replace the sample set in one transaction.
 *
 * Delete-then-insert rather than an upsert per row: a pane that disappeared must disappear from the
 * read model in the same tick, otherwise `incident stalls` reports a pane that no longer exists.
 */
export function writeStallSamples(db: Database.Database, samples: readonly StallSampleRow[]): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM incident_stall_samples').run()
    const insert = db.prepare(
      `INSERT INTO incident_stall_samples (pane_key, terminal_handle, state, state_started_at,
         turn_started_at, last_semantic_event_at, age_ms, age_basis, threshold_ms,
         would_write_if_enabled, reason, declared_wait)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const sample of samples) {
      // A non-finite epoch is not an observation: the decision still counted its rejected key, but a
      // row with no epoch would break the read model's arithmetic.
      if (!Number.isFinite(sample.stateStartedAt)) {
        continue
      }
      insert.run(
        sample.paneKey,
        sample.terminalHandle,
        sample.state,
        sample.stateStartedAt,
        sample.turnStartedAt,
        sample.lastSemanticEventAt,
        sample.ageMs,
        sample.ageBasis,
        sample.thresholdMs,
        sample.wouldWriteIfEnabled ? 1 : 0,
        sample.reason,
        sample.declaredWait
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Best effort; the error below is what matters.
      }
    }
    throw error
  }
}
