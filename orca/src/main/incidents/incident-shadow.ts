// The incident shadow: append-only NDJSON replay hints (issue-sedimentation.md v2.3 §11.2).
//
// This is NOT a write-ahead log and must never be cited as one. The sink buffers up to 32 lines /
// 200ms, has no fsync, and rotation can be interrupted; a crash between the PTY callback and the
// flush loses the line. What it buys is the one window M1 could not cover: the process dying between
// "we know a crash happened" and "the row is committed" — the next start replays these lines into the
// same idempotent insert.
//
// Two hard rules:
//   * every record is pushed AND flushed immediately, or a crash loses exactly the records that
//     matter (the last few);
//   * a line carries the record's key and already-redacted summary, never prompt/transcript bodies.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createLocalFileSink,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  type LocalFileSink
} from '../observability/local-file-sink'
import { redactString } from '../observability/redactor'
import type { IncidentRecord } from './incident-types'
import { incidentsDirectoryFor } from './incidents-paths'

export const INCIDENT_SHADOW_FILENAME = 'shadow.ndjson'
/** Body version of one shadow line; a replay reading a different `v` stops instead of guessing. */
export const INCIDENT_SHADOW_VERSION = 1
const MAX_SUMMARY_CHARS = 2000

/**
 * One line of the shadow, in snake_case because it is a file format (the replay mapping is explicit
 * and a rename here must be a deliberate format change, not a TypeScript refactor).
 */
export type ShadowRecord = {
  v: number
  /** Monotonic within a host's shadow family; time-based so restarts cannot go backwards. */
  seq: number
  id: string
  source_kind: string
  source_id: string
  facet: string
  host_id: string
  worktree_id: string | null
  run_id: string | null
  task_id: string | null
  dispatch_id: string | null
  agent_session_id: string | null
  pty_incarnation_id: string | null
  class: string
  status: string
  exit_cause: unknown
  fingerprint: string
  evidence: unknown
  summary: string
  created_at: number
}

export function shadowFilePath(userDataPath: string): string {
  return join(incidentsDirectoryFor(userDataPath), INCIDENT_SHADOW_FILENAME)
}

let sequence = 0

/**
 * `Date.now() * 1000` keeps the number monotonic across restarts without persisting a counter, and
 * the `+1` tie-break keeps it strictly increasing inside one millisecond.
 */
function nextSequence(now: number): number {
  sequence = Math.max(sequence + 1, now * 1000)
  return sequence
}

export function shadowRecordFromIncident(record: IncidentRecord, now = Date.now()): ShadowRecord {
  return {
    v: INCIDENT_SHADOW_VERSION,
    seq: nextSequence(now),
    id: record.id,
    source_kind: record.sourceKind,
    source_id: record.sourceId,
    facet: record.facet,
    host_id: record.hostId,
    worktree_id: record.worktreeId,
    run_id: record.runId,
    task_id: record.taskId,
    dispatch_id: record.dispatchId,
    agent_session_id: record.agentSessionId,
    pty_incarnation_id: record.ptyIncarnationId,
    class: record.class,
    status: record.status,
    exit_cause: record.exitCause,
    fingerprint: record.fingerprint,
    evidence: record.evidence,
    // Redacted here as well as in the store: the shadow must not be the leak path.
    summary: redactString(record.summary).slice(0, MAX_SUMMARY_CHARS),
    created_at: record.createdAt
  }
}

let sink: LocalFileSink | null = null
let sinkPath: string | null = null

function shadowSink(path: string): LocalFileSink {
  if (sink !== null && sinkPath === path) {
    return sink
  }
  sink?.close()
  sink = createLocalFileSink({
    filePath: path,
    maxBytes: DEFAULT_MAX_BYTES,
    maxFiles: DEFAULT_MAX_FILES,
    // One line per flush is the point here, not batching: `appendShadowRecord` also calls flush().
    flushBufferThreshold: 1
  })
  sinkPath = path
  return sink
}

/**
 * Runtime path: push one record and flush immediately (§11.2).
 *
 * Never throws. A shadow failure is a diagnostics counter, because losing the hint must not turn a
 * PTY exit or a CLI report into an error.
 */
export function appendShadowRecord(
  userDataPath: string,
  record: IncidentRecord,
  now = Date.now()
): { written: boolean; reason?: string } {
  try {
    // The sink serializes one record per line itself; passing a pre-serialized string would nest it.
    const target = shadowSink(shadowFilePath(userDataPath))
    target.push(shadowRecordFromIncident(record, now))
    target.flush()
    return { written: true }
  } catch (error) {
    return { written: false, reason: error instanceof Error ? error.name : 'shadow_write_failed' }
  }
}

/**
 * CLI path: one `write()` per line, no long-lived fd.
 *
 * The main process keeps an O_APPEND fd for its whole life; this process lives for one command. A
 * single append per line keeps the two writers from interleaving inside a line, and rotation stays
 * the runtime's job (the CLI never renames files out from under it).
 */
export function appendShadowRecordFromCli(
  userDataPath: string,
  record: IncidentRecord,
  now = Date.now()
): { written: boolean; reason?: string } {
  try {
    const path = shadowFilePath(userDataPath)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(shadowRecordFromIncident(record, now))}\n`, {
      mode: 0o600
    })
    return { written: true }
  } catch (error) {
    return { written: false, reason: error instanceof Error ? error.name : 'shadow_write_failed' }
  }
}

/** Flush + close the runtime sink. Called by startup reconcile before it reads the files. */
export function closeIncidentShadowSink(): void {
  sink?.close()
  sink = null
  sinkPath = null
}

export function __resetIncidentShadowForTests(): void {
  closeIncidentShadowSink()
  sequence = 0
}
