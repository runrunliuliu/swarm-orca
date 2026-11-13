// The shadow replay's coverage facts (issue-sedimentation.md v2.3 §11.2, M2-C4/C6).
//
// "No incidents" and "we could not finish reading the hints" are different answers, so the read model
// must carry the replay's own state. Everything here is read from `incident_store_meta`, which means
// it survives the process that wrote it — a CLI `list` after a failed start can still say the replay
// was incomplete.

import type Database from '../sqlite/sync-database'
import { readMeta, readMetaNumber } from './incident-store-meta'

/** Watermark: the highest seq the DB has accepted or deliberately dropped. */
export const SHADOW_REPLAYED_SEQ_META = 'shadow_replayed_seq'
/** `'1'` while the last run stopped early (torn line, budget, refusal). */
export const SHADOW_REPLAY_INCOMPLETE_META = 'shadow_replay_incomplete'
export const SHADOW_LAST_STOP_REASON_META = 'shadow_last_stop_reason'
export const SHADOW_RECONCILE_FAILURES_META = 'shadow_reconcile_failures'
export const SHADOW_RECONCILE_LAST_ERROR_META = 'shadow_reconcile_last_error'
/** Lines the store refused for capacity — durable evidence that something was not recorded. */
export const SHADOW_DROPPED_META = 'shadow_dropped'
export const SHADOW_LAST_DROPPED_REASON_META = 'shadow_last_dropped_reason'
/** Last run's cost, so a cold start's replay time is visible instead of guessed (M2-C6). */
export const SHADOW_LAST_RUN_LINES_META = 'shadow_last_run_lines'
export const SHADOW_LAST_RUN_BYTES_META = 'shadow_last_run_bytes'
export const SHADOW_LAST_RUN_MS_META = 'shadow_last_run_ms'

export type IncidentShadowReplayCoverage = {
  /** Highest replayed seq; 0 means "nothing has been replayed on this host". */
  lastSeq: number
  /** True when the last run stopped before the end of the family. */
  incomplete: boolean
  lastStopReason: string | null
  failures: number
  lastError: string | null
  /** Lines the store refused (capacity); the record exists only in the shadow. */
  dropped: number
  lastDroppedReason: string | null
  lastRun: { lines: number; bytes: number; ms: number } | null
}

export function readShadowReplayCoverage(db: Database.Database): IncidentShadowReplayCoverage {
  const runLines = readMeta(db, SHADOW_LAST_RUN_LINES_META)
  const runBytes = readMeta(db, SHADOW_LAST_RUN_BYTES_META)
  const runMs = readMeta(db, SHADOW_LAST_RUN_MS_META)
  return {
    lastSeq: readMetaNumber(db, SHADOW_REPLAYED_SEQ_META),
    incomplete: readMeta(db, SHADOW_REPLAY_INCOMPLETE_META) === '1',
    lastStopReason: readMeta(db, SHADOW_LAST_STOP_REASON_META),
    failures: readMetaNumber(db, SHADOW_RECONCILE_FAILURES_META),
    lastError: readMeta(db, SHADOW_RECONCILE_LAST_ERROR_META),
    dropped: readMetaNumber(db, SHADOW_DROPPED_META),
    lastDroppedReason: readMeta(db, SHADOW_LAST_DROPPED_REASON_META),
    lastRun:
      runLines === null && runBytes === null && runMs === null
        ? null
        : {
            lines: readMetaNumber(db, SHADOW_LAST_RUN_LINES_META),
            bytes: readMetaNumber(db, SHADOW_LAST_RUN_BYTES_META),
            ms: readMetaNumber(db, SHADOW_LAST_RUN_MS_META)
          }
  }
}

/** True when the replay state says the hint family has not been fully consumed yet. */
export function shadowReplayIncomplete(coverage: IncidentShadowReplayCoverage): boolean {
  return coverage.incomplete
}
