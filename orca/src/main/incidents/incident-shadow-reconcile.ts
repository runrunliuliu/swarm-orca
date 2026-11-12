// Startup replay of the incident shadow (issue-sedimentation.md v2.3 §11.2).
//
// The shadow is a hint log, so replaying it must be safe to do any number of times: every line goes
// through `insertIncident`, whose UNIQUE(source_kind, source_id, facet) makes a second write a no-op.
// That is what lets the watermark be an optimization rather than a correctness requirement — and why
// losing the watermark is never a reason to guess.
//
// Two failure modes are handled by *stopping*, never by repairing:
//   * a line that does not parse (a torn tail from a crash mid-write);
//   * a line this build cannot rebuild (different body version, unknown class/status, missing key).
// Everything before it is replayed and the watermark points at the last complete line; the file is
// left exactly as found so the operator (or a later build) can look at it.

import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type Database from '../sqlite/sync-database'
import { DEFAULT_MAX_FILES, listRotatedFiles } from '../observability/local-file-sink'
import type { IncidentRecord } from './incident-types'
import { shadowFilePath } from './incident-shadow'
import {
  ShadowRecordError,
  completeLines,
  incidentRecordFromShadowLine,
  readFileSlice
} from './incident-shadow-line'
import type { IncidentStore } from './incident-store'
import { readMeta, writeMeta } from './incident-store-capacity'

/** Watermark keys in `incident_store_meta`. The file is a basename, so rotation keeps it valid. */
export const SHADOW_WATERMARK_FILE_META = 'shadow_replayed_file'
export const SHADOW_WATERMARK_OFFSET_META = 'shadow_replayed_offset'
export const SHADOW_RECONCILE_FAILURES_META = 'shadow_reconcile_failures'
export const SHADOW_RECONCILE_LAST_ERROR_META = 'shadow_reconcile_last_error'

/** Persist the watermark every N lines so a crash mid-file does not rescan the whole file. */
const WATERMARK_EVERY_LINES = 500
const MAX_ERROR_CHARS = 300

export type ShadowReconcileStopReason =
  | 'unparsable_json'
  | 'unsupported_version'
  | 'invalid_record'
  | 'store_refused'
  | 'read_error'

export type ShadowReconcileStop = {
  file: string
  /** Last good byte offset: the next run resumes here. */
  offset: number
  reason: ShadowReconcileStopReason
  detail?: string
}

export type ShadowReconcileSummary = {
  /** Files present in the family this run looked at. */
  files: number
  /** Lines that parsed and were handed to the store. */
  replayed: number
  inserted: number
  duplicates: number
  stopped: ShadowReconcileStop | null
  watermark: { file: string; offset: number } | null
}

function watermarkOf(db: Database.Database): { file: string; offset: number } | null {
  const file = readMeta(db, SHADOW_WATERMARK_FILE_META)
  const rawOffset = Number(readMeta(db, SHADOW_WATERMARK_OFFSET_META) ?? 0)
  if (!file || !Number.isFinite(rawOffset) || rawOffset < 0) {
    return null
  }
  return { file, offset: rawOffset }
}

function writeWatermark(
  db: Database.Database,
  watermark: { file: string; offset: number }
): void {
  writeMeta(db, SHADOW_WATERMARK_FILE_META, watermark.file)
  writeMeta(db, SHADOW_WATERMARK_OFFSET_META, String(watermark.offset))
}

/**
 * Replay every complete shadow line after the watermark.
 *
 * Order is oldest → newest (`listRotatedFiles` is newest-first because trace bundling wants that).
 * Files older than the watermark's file are skipped without being read — that is the "no full
 * rescan" property. If the watermark's file is gone (rotated away or deleted), replay restarts from
 * the oldest present file; the inserts are idempotent, so the only cost is time.
 */
export function reconcileIncidentShadow(options: {
  store: IncidentStore
  db: Database.Database
  userDataPath: string
  maxFiles?: number
}): ShadowReconcileSummary {
  const { store, db, userDataPath } = options
  const path = shadowFilePath(userDataPath)
  const files = listRotatedFiles(path, options.maxFiles ?? DEFAULT_MAX_FILES).toReversed()
  const watermark = watermarkOf(db)
  const summary: ShadowReconcileSummary = {
    files: files.length,
    replayed: 0,
    inserted: 0,
    duplicates: 0,
    stopped: null,
    watermark
  }
  if (files.length === 0) {
    return summary
  }

  const startIndex = watermark ? files.findIndex((file) => basename(file) === watermark.file) : -1
  let linesSinceWatermark = 0

  for (let index = Math.max(0, startIndex); index < files.length; index += 1) {
    const file = files[index]
    if (!existsSync(file)) {
      continue
    }
    const size = statSync(file).size
    const from =
      index === startIndex && watermark !== null && size >= watermark.offset ? watermark.offset : 0
    let buffer: Buffer
    try {
      buffer = readFileSlice(file, from)
    } catch (error) {
      summary.stopped = {
        file: basename(file),
        offset: from,
        reason: 'read_error',
        detail: error instanceof Error ? error.name : 'read_failed'
      }
      break
    }

    let consumedTo = from
    for (const line of completeLines(buffer)) {
      const lineEnd = from + line.endOffset
      if (line.text.trim().length === 0) {
        consumedTo = lineEnd
        continue
      }
      let record: IncidentRecord
      try {
        record = incidentRecordFromShadowLine(line.text)
      } catch (error) {
        summary.stopped = {
          file: basename(file),
          offset: consumedTo,
          reason:
            error instanceof ShadowRecordError ? error.reason : 'unparsable_json',
          detail:
            error instanceof Error ? error.message.slice(0, MAX_ERROR_CHARS) : undefined
        }
        break
      }
      const result = store.insertIncident(record)
      if (result.outcome !== 'inserted' && result.outcome !== 'duplicate') {
        // Capacity/read-only refusals must not advance past the line: stopping makes the next start
        // retry it, whereas skipping would mark a line replayed that never landed.
        summary.stopped = {
          file: basename(file),
          offset: consumedTo,
          reason: 'store_refused',
          detail: `insert_${result.outcome}`
        }
        break
      }
      summary.replayed += 1
      if (result.outcome === 'inserted') {
        summary.inserted += 1
      } else {
        summary.duplicates += 1
      }
      consumedTo = lineEnd
      summary.watermark = { file: basename(file), offset: consumedTo }
      linesSinceWatermark += 1
      if (linesSinceWatermark >= WATERMARK_EVERY_LINES) {
        writeWatermark(db, { file: basename(file), offset: consumedTo })
        linesSinceWatermark = 0
      }
    }

    // The last good position is the resume point, whether we stopped or finished the file.
    writeWatermark(db, { file: basename(file), offset: consumedTo })
    summary.watermark = { file: basename(file), offset: consumedTo }
    linesSinceWatermark = 0
    if (summary.stopped !== null) {
      break
    }
  }
  return summary
}

/**
 * Record a reconcile failure so it is visible without a log reader (§11.2 "不得静默").
 *
 * The counter lives in the store when the store is reachable; the caller also logs one line. A write
 * failure here is swallowed — this is already the failure path.
 */
export function recordShadowReconcileFailure(db: Database.Database, message: string): void {
  try {
    const previous = Number(readMeta(db, SHADOW_RECONCILE_FAILURES_META) ?? 0)
    writeMeta(
      db,
      SHADOW_RECONCILE_FAILURES_META,
      String((Number.isFinite(previous) ? previous : 0) + 1)
    )
    writeMeta(db, SHADOW_RECONCILE_LAST_ERROR_META, message.slice(0, MAX_ERROR_CHARS))
  } catch {
    // The caller still logs; nothing else to do from inside the failure path.
  }
}
