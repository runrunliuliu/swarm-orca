import {
  isTaskRecordTranscriptPresence,
  type TaskRecordTranscriptCheck,
  type TaskRecordsDiscardedFacts
} from './task-records-types'
import { KNOWN_TRANSCRIPT_CHECK_FIELDS } from './task-records-preserved-fields'

/**
 * Load-boundary reader for one transcript check (issue #53: paths and check
 * values, never content) plus the fixed-order shape the merge uses for change
 * detection.
 *
 * Why its own module: `task-records-runs-normalize.ts` is at its `max-lines`
 * budget, and this record has its own rule — an **undated or unlabelled stat is
 * not evidence**, so an unreadable `checkedAt`/`presence` drops the whole check
 * (counted in `transcriptChecks`) instead of keeping half a measurement that the
 * reader would show as a weaker verification it never performed.
 *
 * The three tiny JSON guards below are repeated rather than exported from the row
 * normalizer so the two modules stay free of an import cycle.
 */

export function normalizeTranscriptCheck(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): TaskRecordTranscriptCheck | undefined {
  // Absent is legal and means "never checked": the path may still be stored.
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    discarded.transcriptChecks += 1
    return undefined
  }
  countUnknownFields(value, KNOWN_TRANSCRIPT_CHECK_FIELDS, discarded)
  const checkedAt = finiteNumber(value.checkedAt)
  if (checkedAt === null || !isTaskRecordTranscriptPresence(value.presence)) {
    discarded.transcriptChecks += 1
    return undefined
  }
  const dev = measuredField(value.dev, discarded)
  const ino = measuredField(value.ino, discarded)
  const mtimeMs = measuredField(value.mtimeMs, discarded)
  const size = measuredField(value.size, discarded)
  return {
    checkedAt,
    presence: value.presence,
    ...(dev === undefined ? {} : { dev }),
    ...(ino === undefined ? {} : { ino }),
    ...(mtimeMs === undefined ? {} : { mtimeMs }),
    ...(size === undefined ? {} : { size })
  }
}

/** Fixed field order rather than a deep-equal: a field added to the type but not
 *  here would silently stop counting as a change. `null` cannot collide with a
 *  stored value (numbers are finite and non-negative, `presence` is a word). */
export function taskRecordTranscriptCheckShape(check: TaskRecordTranscriptCheck): string {
  return JSON.stringify([
    check.checkedAt,
    check.presence,
    check.dev ?? null,
    check.ino ?? null,
    check.mtimeMs ?? null,
    check.size ?? null
  ])
}

/** A stat value the platform did not report, or reported as something this build
 *  cannot read, is dropped and counted: unknown, never `0`. */
function measuredField(
  value: unknown,
  discarded: TaskRecordsDiscardedFacts
): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = finiteNumber(value)
  if (parsed === null || parsed < 0) {
    discarded.fields += 1
    return undefined
  }
  return parsed
}

function countUnknownFields(
  entry: Record<string, unknown>,
  known: readonly string[],
  discarded: TaskRecordsDiscardedFacts
): void {
  for (const name of Object.keys(entry)) {
    if (!known.includes(name)) {
      discarded.fields += 1
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
