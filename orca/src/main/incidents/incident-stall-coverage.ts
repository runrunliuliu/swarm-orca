// The stall sampler's coverage facts (issue-sedimentation.md v2.4 §7.2, M3-3).
//
// The grayscale question is "is this about to be wall-to-wall?", and the only way to answer it is to
// publish what the last sample saw: how many panes, how many would stall, how many are declared
// quiet, and whether the writer is even on. All of it lives in meta so a CLI invocation (a different
// process) can read it without the runtime being alive.

import type Database from '../sqlite/sync-database'
import { readMeta } from './incident-store-meta'
import type { IncidentStallSampleCoverage } from './incident-types'
import { readDeclaredWaitCount } from './incident-wait'

export const STALL_LAST_SAMPLE_AT_META = 'stall_last_sample_at'
export const STALL_SAMPLE_PANES_META = 'stall_sample_panes'
export const STALL_SAMPLE_WOULD_META = 'stall_sample_would_stall'
export const STALL_SAMPLE_STALLED_META = 'stall_sample_stalled'
export const STALL_WRITE_ENABLED_META = 'stall_write_enabled'
export const STALL_WRITES_META = 'stall_writes'
export const STALL_LAST_WRITE_AT_META = 'stall_last_write_at'
export const STALL_SAMPLER_ERRORS_META = 'stall_sampler_errors'
export const STALL_LAST_SAMPLER_ERROR_META = 'stall_last_sampler_error'
/** Stall writes refused because `buildIncidentKey` rejected the pane/epoch (M3-C2). */
export const STALL_KEY_REJECTED_META = 'stall_key_rejected'
export const STALL_LAST_KEY_REJECTED_META = 'stall_last_key_rejected'

function numberFrom(db: Database.Database, key: string): number {
  const value = Number(readMeta(db, key) ?? 0)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function readStallSampleCoverage(db: Database.Database): IncidentStallSampleCoverage {
  const sampledAtRaw = readMeta(db, STALL_LAST_SAMPLE_AT_META)
  const lastWriteRaw = readMeta(db, STALL_LAST_WRITE_AT_META)
  return {
    sampledAt: sampledAtRaw === null ? null : Number(sampledAtRaw),
    panes: numberFrom(db, STALL_SAMPLE_PANES_META),
    wouldWrite: numberFrom(db, STALL_SAMPLE_WOULD_META),
    noEvent: numberFrom(db, STALL_SAMPLE_STALLED_META),
    declaredWaits: readDeclaredWaitCount(db),
    writeEnabled: readMeta(db, STALL_WRITE_ENABLED_META) === '1',
    writes: numberFrom(db, STALL_WRITES_META),
    lastWriteAt: lastWriteRaw === null ? null : Number(lastWriteRaw),
    errors: numberFrom(db, STALL_SAMPLER_ERRORS_META),
    lastError: readMeta(db, STALL_LAST_SAMPLER_ERROR_META),
    keyRejected: numberFrom(db, STALL_KEY_REJECTED_META)
  }
}

/** One line for the CLI's coverage note: the sampler is a fact, not a guess. */
export function formatStallSampleNote(coverage: IncidentStallSampleCoverage): string {
  const sampled =
    coverage.sampledAt === null
      ? 'never'
      : new Date(coverage.sampledAt).toISOString()
  const errors =
    coverage.errors > 0 ? `  errors=${coverage.errors}  last_error=${coverage.lastError ?? 'unknown'}` : ''
  const rejected = coverage.keyRejected > 0 ? `  key_rejected=${coverage.keyRejected}` : ''
  return (
    `Stall sampler: last_sample=${sampled}  panes=${coverage.panes}  ` +
    `would_write=${coverage.wouldWrite}  no_event=${coverage.noEvent}  ` +
    `declared_waits=${coverage.declaredWaits}  ` +
    `write=${coverage.writeEnabled ? 'on' : 'off'}  writes=${coverage.writes}` +
    `${errors}${rejected}`
  )
}
