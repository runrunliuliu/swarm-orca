// Startup replay of the incident shadow (issue-sedimentation.md v2.3 §11.2; M2-C1/C3/C4/C6).
//
// The watermark is a single number: the highest `seq` this store has accepted or deliberately
// dropped. Replay scans the whole family oldest → newest and handles lines with `seq > lastSeq`; the
// store's UNIQUE(source_kind, source_id, facet) absorbs anything that gets re-offered. That makes the
// watermark an optimization and a progress marker, never a correctness requirement — losing it costs
// time, not records.
//
// Failure policy is "stop, never repair": a line that does not parse, a body version this build does
// not know, or a store that refuses everything all stop the run at the last good seq, with the file
// left exactly as found. Capacity refusals are the one exception that does not stop: a non-crash line
// the capacity gate rejects is *dropped durably* (counted in meta) and replay continues, so a noisy
// backlog can never hide a later crash (M2-C3).
//
// Cost is bounded per process (M2-C6): a byte and line budget stops the run with `incomplete: true`
// and the next start resumes from `lastSeq`. Files whose *last* line is already at or below the
// watermark are skipped by reading only their tail, so a steady-state start does not touch ~100MB.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type Database from '../sqlite/sync-database'
import { DEFAULT_MAX_FILES, listRotatedFiles } from '../observability/local-file-sink'
import type { IncidentRecord } from './incident-types'
import { shadowFilePath } from './incident-shadow'
import {
  ShadowRecordError,
  completeLines,
  incidentRecordFromShadowLine,
  readFileSlice,
  shadowLineSeq
} from './incident-shadow-line'
import { lastSeqInTail } from './incident-shadow-tail'
import {
  SHADOW_DROPPED_META,
  SHADOW_LAST_DROPPED_REASON_META,
  SHADOW_LAST_RUN_BYTES_META,
  SHADOW_LAST_RUN_LINES_META,
  SHADOW_LAST_RUN_MS_META,
  SHADOW_LAST_STOP_REASON_META,
  SHADOW_RECONCILE_FAILURES_META,
  SHADOW_RECONCILE_LAST_ERROR_META,
  SHADOW_REPLAYED_SEQ_META,
  SHADOW_REPLAY_INCOMPLETE_META,
  readShadowReplayCoverage,
  type IncidentShadowReplayCoverage
} from './incident-shadow-coverage'
import type { IncidentStore } from './incident-store'
import { bumpMetaNumber, readMetaNumber, writeMeta } from './incident-store-meta'

/** Persist progress every N handled lines so a crash mid-run resumes close to where it stopped. */
const PROGRESS_EVERY_LINES = 500
const MAX_ERROR_CHARS = 300

/** Per-process replay budget: a cold start must not synchronously chew through ~100MB (M2-C6). */
export const DEFAULT_SHADOW_REPLAY_BUDGET = {
  maxBytes: 8 * 1024 * 1024,
  maxLines: 20_000
} as const

export type ShadowReplayBudget = {
  maxBytes: number
  maxLines: number
}

export type ShadowReconcileStopReason =
  | 'unparsable_json'
  | 'unsupported_version'
  | 'invalid_record'
  | 'store_refused'
  | 'read_error'
  | 'budget'

export type ShadowReconcileStop = {
  file: string
  /** Seq of the last handled line; the next run resumes strictly after it. */
  lastSeq: number
  reason: ShadowReconcileStopReason
  detail?: string
}

export type ShadowReconcileSummary = {
  files: number
  filesRead: number
  /** Lines this run handled (inserted, duplicate or dropped). */
  replayed: number
  inserted: number
  duplicates: number
  /** Non-crash lines the capacity gate refused; counted durably, then skipped. */
  dropped: number
  /** Bytes read from disk during this run (budget accounting). */
  bytesRead: number
  elapsedMs: number
  stopped: ShadowReconcileStop | null
  /** True when this run did not reach the end of the family. */
  incomplete: boolean
  watermark: number
}

/** Backwards-compatible aliases for the meta keys other modules import. */
export { SHADOW_RECONCILE_FAILURES_META, SHADOW_RECONCILE_LAST_ERROR_META }

/**
 * Replay every line with `seq > lastSeq`.
 *
 * Order is oldest → newest (`listRotatedFiles` is newest-first for trace bundling). A file is skipped
 * entirely when its tail seq is at or below the watermark — the whole file is then old by
 * construction, because seq increases with append order.
 */
export function reconcileIncidentShadow(options: {
  store: IncidentStore
  db: Database.Database
  userDataPath: string
  maxFiles?: number
  budget?: Partial<ShadowReplayBudget>
  /** Injectable clock so the budget/duration assertions are deterministic. */
  now?: () => number
}): ShadowReconcileSummary {
  const { store, db, userDataPath } = options
  const budget: ShadowReplayBudget = { ...DEFAULT_SHADOW_REPLAY_BUDGET, ...options.budget }
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const path = shadowFilePath(userDataPath)
  const files = listRotatedFiles(path, options.maxFiles ?? DEFAULT_MAX_FILES).toReversed()
  const watermark = readMetaNumber(db, SHADOW_REPLAYED_SEQ_META)
  const summary: ShadowReconcileSummary = {
    files: files.length,
    filesRead: 0,
    replayed: 0,
    inserted: 0,
    duplicates: 0,
    dropped: 0,
    bytesRead: 0,
    elapsedMs: 0,
    stopped: null,
    incomplete: false,
    watermark
  }
  let lastSeq = watermark

  const finish = (stop: ShadowReconcileStop | null): ShadowReconcileSummary => {
    summary.stopped = stop
    summary.incomplete = stop !== null
    summary.watermark = lastSeq
    summary.elapsedMs = Math.max(0, now() - startedAt)
    writeMeta(db, SHADOW_REPLAYED_SEQ_META, String(lastSeq))
    writeMeta(db, SHADOW_REPLAY_INCOMPLETE_META, summary.incomplete ? '1' : '0')
    writeMeta(db, SHADOW_LAST_STOP_REASON_META, stop === null ? '' : stop.reason)
    writeMeta(db, SHADOW_LAST_RUN_LINES_META, String(summary.replayed))
    writeMeta(db, SHADOW_LAST_RUN_BYTES_META, String(summary.bytesRead))
    writeMeta(db, SHADOW_LAST_RUN_MS_META, String(summary.elapsedMs))
    return summary
  }

  if (files.length === 0) {
    return finish(null)
  }

  for (const file of files) {
    if (summary.stopped !== null) {
      break
    }
    if (!existsSync(file)) {
      continue
    }
    // Skip a file whose newest line is already covered: seq is append-ordered, so nothing in it is new.
    const tailSeq = lastSeqInTail(file)
    if (tailSeq !== null && tailSeq <= lastSeq) {
      continue
    }
    let buffer: Buffer
    try {
      buffer = readFileSlice(file, 0)
    } catch (error) {
      summary.stopped = {
        file: basename(file),
        lastSeq,
        reason: 'read_error',
        detail: error instanceof Error ? error.name : 'read_failed'
      }
      break
    }
    summary.filesRead += 1
    summary.bytesRead += buffer.length

    let handledSinceProgress = 0
    for (const line of completeLines(buffer)) {
      if (line.text.trim().length === 0) {
        continue
      }
      if (summary.replayed >= budget.maxLines || summary.bytesRead >= budget.maxBytes) {
        summary.stopped = {
          file: basename(file),
          lastSeq,
          reason: 'budget',
          detail: `lines=${summary.replayed} bytes=${summary.bytesRead}`
        }
        break
      }
      let seq: number
      try {
        seq = shadowLineSeq(line.text)
      } catch (error) {
        summary.stopped = {
          file: basename(file),
          lastSeq,
          reason: error instanceof ShadowRecordError ? error.reason : 'unparsable_json',
          detail: error instanceof Error ? error.message.slice(0, MAX_ERROR_CHARS) : undefined
        }
        break
      }
      if (seq <= lastSeq) {
        continue
      }
      let record: IncidentRecord
      try {
        record = incidentRecordFromShadowLine(line.text)
      } catch (error) {
        summary.stopped = {
          file: basename(file),
          lastSeq,
          reason: error instanceof ShadowRecordError ? error.reason : 'unparsable_json',
          detail: error instanceof Error ? error.message.slice(0, MAX_ERROR_CHARS) : undefined
        }
        break
      }
      const result = store.insertIncident(record)
      if (result.outcome === 'capacity_limited' && record.class !== 'crash') {
        // M2-C3: a refused noise line must not block the rest of the family. It is dropped durably —
        // the count and the last reason are the only trace it ever existed — and replay moves on.
        summary.dropped += 1
        bumpMetaNumber(db, SHADOW_DROPPED_META)
        writeMeta(db, SHADOW_LAST_DROPPED_REASON_META, `capacity_limited:${result.limitedBy ?? 'unknown'}`)
      } else if (result.outcome === 'read_only' || result.outcome === 'capacity_limited') {
        // Crash rows bypass capacity, so a refusal here means the store cannot take writes at all.
        summary.stopped = {
          file: basename(file),
          lastSeq,
          reason: 'store_refused',
          detail: `insert_${result.outcome}`
        }
        break
      } else if (result.outcome === 'invalid_record') {
        summary.stopped = {
          file: basename(file),
          lastSeq,
          reason: 'invalid_record',
          detail: result.reason ?? 'invalid_record'
        }
        break
      } else {
        summary.replayed += 1
        if (result.outcome === 'inserted') {
          summary.inserted += 1
        } else {
          summary.duplicates += 1
        }
      }
      lastSeq = Math.max(lastSeq, seq)
      handledSinceProgress += 1
      if (handledSinceProgress >= PROGRESS_EVERY_LINES) {
        writeMeta(db, SHADOW_REPLAYED_SEQ_META, String(lastSeq))
        handledSinceProgress = 0
      }
    }
  }
  return finish(summary.stopped)
}

/**
 * Record a reconcile failure so it is visible without a log reader (§11.2 "不得静默").
 *
 * The counter lives in the store when the store is reachable; the caller also logs one line. A write
 * failure here is swallowed — this is already the failure path.
 */
export function recordShadowReconcileFailure(db: Database.Database, message: string): void {
  try {
    bumpMetaNumber(db, SHADOW_RECONCILE_FAILURES_META)
    writeMeta(db, SHADOW_RECONCILE_LAST_ERROR_META, message.slice(0, MAX_ERROR_CHARS))
    // A thrown run never reached the end, so the read model must not present it as complete.
    writeMeta(db, SHADOW_REPLAY_INCOMPLETE_META, '1')
  } catch {
    // The caller still logs; nothing else to do from inside the failure path.
  }
}

export type { IncidentShadowReplayCoverage }
export { readShadowReplayCoverage }
