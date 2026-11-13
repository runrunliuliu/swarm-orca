// Pane event clocks (M8-2): the facts the main process can see, with no verdict attached.
//
// The old sampler answered "is this pane stuck?" in the main process: a 45-minute threshold, an
// observation-cycle counter, a `wouldWriteIfEnabled` verdict and a default-off writer. M8 deletes that
// judgement and keeps the observation — which pane, which state, when its last semantic event was,
// and which clock the age came from. The threshold is a triage question now, not a code constant, so
// this table has no threshold, no verdict and no reason column.
//
// `ageBasis` is still stored: it is a fact about the data (did the host report a semantic clock at
// all), not a judgement, and a reader must be able to tell a weaker age from a stronger one.

import type Database from '../sqlite/sync-database'
import type { IncidentPaneClockCoverage } from './incident-types'
import { bumpMetaNumber, readMeta, writeMeta } from './incident-store-meta'
import { publishDeclaredWaitCount, readDeclaredWaitCount } from './incident-wait'

/** One sample per minute: enough to make an age useful without a per-event timer. */
export const PANE_CLOCK_SAMPLE_INTERVAL_MS = 60 * 1000

export const PANE_CLOCK_LAST_SAMPLE_AT_META = 'pane_clock_last_sample_at'
export const PANE_CLOCK_PANES_META = 'pane_clock_panes'
export const PANE_CLOCK_SKIPPED_META = 'pane_clock_skipped'
export const PANE_CLOCK_ERRORS_META = 'pane_clock_errors'
export const PANE_CLOCK_LAST_ERROR_META = 'pane_clock_last_error'

export type PaneClockFact = {
  paneKey: string
  terminalHandle: string | null
  state: string
  stateStartedAt: number
  turnStartedAt: number | null
  /** `evidenceObservedAt`, or null when the host never reported one (then age falls back). */
  lastSemanticEventAt: number | null
}

/** A stored fact as a reader sees it: the fact plus the age computed at read time. */
export type PaneClockRow = PaneClockFact & {
  ageMs: number
  ageBasis: 'event' | 'state_fallback'
  observedAt: number
  /** The operator's declaration for this pane+epoch, if one applies. A fact, not a suppressor. */
  declaredWait: string | null
}

function ageBasisFor(fact: PaneClockFact): 'event' | 'state_fallback' {
  return fact.lastSemanticEventAt === null ? 'state_fallback' : 'event'
}

/**
 * Replace the pane clock set in one transaction.
 *
 * Delete-then-insert rather than an upsert per pane: a pane that disappeared from the status snapshot
 * must disappear here in the same tick, or the read model keeps reporting a pane that no longer
 * exists. A non-finite epoch is skipped and counted, never written as 0.
 */
export function replacePaneClocks(
  db: Database.Database,
  facts: readonly PaneClockFact[],
  observedAt: number
): { written: number; skipped: number } {
  let written = 0
  let skipped = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM incident_pane_clocks').run()
    const insert = db.prepare(
      `INSERT INTO incident_pane_clocks (pane_key, terminal_handle, state, state_started_at,
         turn_started_at, last_semantic_event_at, age_basis, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const fact of facts) {
      if (!Number.isFinite(fact.stateStartedAt)) {
        skipped += 1
        continue
      }
      insert.run(
        fact.paneKey,
        fact.terminalHandle,
        fact.state,
        fact.stateStartedAt,
        fact.turnStartedAt,
        fact.lastSemanticEventAt,
        ageBasisFor(fact),
        observedAt
      )
      written += 1
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
  return { written, skipped }
}

export function bumpPaneClockSkipped(db: Database.Database, skipped: number): void {
  if (skipped > 0) {
    bumpMetaNumber(db, PANE_CLOCK_SKIPPED_META, skipped)
  }
}

/**
 * Read the last sample. `declaredWait` is joined from the declaration table for the SAME epoch, so a
 * respawned pane never inherits a promise made against its predecessor.
 */
export function readPaneClocks(db: Database.Database, now: number): PaneClockRow[] {
  const rows = db
    .prepare(
      `SELECT c.pane_key, c.terminal_handle, c.state, c.state_started_at, c.turn_started_at,
              c.last_semantic_event_at, c.age_basis, c.observed_at, w.reason AS declared_wait
         FROM incident_pane_clocks c
         LEFT JOIN incident_wait_declarations w
           ON w.pane_key = c.pane_key
          AND w.epoch = CAST(c.state_started_at AS TEXT)
          AND (w.expires_at IS NULL OR w.expires_at > ?)
        ORDER BY c.pane_key ASC`
    )
    .all(now) as Record<string, unknown>[]
  return rows.map((row) => {
    const lastSemanticEventAt =
      row.last_semantic_event_at === null ? null : Number(row.last_semantic_event_at)
    const stateStartedAt = Number(row.state_started_at)
    const basis: 'event' | 'state_fallback' =
      row.age_basis === 'event' ? 'event' : 'state_fallback'
    return {
      paneKey: String(row.pane_key),
      terminalHandle: row.terminal_handle === null ? null : String(row.terminal_handle),
      state: String(row.state),
      stateStartedAt,
      turnStartedAt: row.turn_started_at === null ? null : Number(row.turn_started_at),
      lastSemanticEventAt,
      ageMs: Math.max(0, now - (lastSemanticEventAt ?? stateStartedAt)),
      ageBasis: basis,
      observedAt: Number(row.observed_at),
      declaredWait: row.declared_wait === null ? null : String(row.declared_wait)
    }
  })
}

function numberFrom(db: Database.Database, key: string): number {
  const value = Number(readMeta(db, key) ?? 0)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function readPaneClockCoverage(db: Database.Database): IncidentPaneClockCoverage {
  const sampledAtRaw = readMeta(db, PANE_CLOCK_LAST_SAMPLE_AT_META)
  return {
    sampledAt: sampledAtRaw === null ? null : Number(sampledAtRaw),
    panes: numberFrom(db, PANE_CLOCK_PANES_META),
    declaredWaits: readDeclaredWaitCount(db),
    skipped: numberFrom(db, PANE_CLOCK_SKIPPED_META),
    errors: numberFrom(db, PANE_CLOCK_ERRORS_META),
    lastError: readMeta(db, PANE_CLOCK_LAST_ERROR_META)
  }
}

export function publishPaneClockCoverage(
  db: Database.Database,
  values: { sampledAt: number; panes: number; declaredWaits: number }
): void {
  writeMeta(db, PANE_CLOCK_LAST_SAMPLE_AT_META, String(values.sampledAt))
  writeMeta(db, PANE_CLOCK_PANES_META, String(values.panes))
  publishDeclaredWaitCount(db, values.declaredWaits)
}

/** One line for every read surface: the sampler is a fact, not a guess. */
export function formatPaneClockNote(coverage: IncidentPaneClockCoverage): string {
  const sampled =
    coverage.sampledAt === null ? 'never' : new Date(coverage.sampledAt).toISOString()
  const errors =
    coverage.errors > 0
      ? `  errors=${coverage.errors}  last_error=${coverage.lastError ?? 'unknown'}`
      : ''
  const skipped = coverage.skipped > 0 ? `  skipped=${coverage.skipped}` : ''
  return (
    `Pane clock: last_sample=${sampled}  panes=${coverage.panes}  ` +
    `declared_waits=${coverage.declaredWaits}${errors}${skipped}`
  )
}
