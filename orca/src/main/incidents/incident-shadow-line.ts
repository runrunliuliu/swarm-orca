// Reading one shadow line back into a record (issue-sedimentation.md v2.3 §11.2).
//
// The shadow is a file format, so this is where "the writer and this build disagree" becomes loud:
// every failure throws a typed reason and the caller stops before the bad line. Nothing here repairs
// or defaults a field into existence — a fabricated record is worse than a replay that stopped.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import {
  isIncidentClass,
  isIncidentSourceKind,
  isIncidentStatus,
  type IncidentRecord
} from './incident-types'
import { INCIDENT_SHADOW_VERSION, type ShadowRecord } from './incident-shadow'

type ShadowLine = { text: string; endOffset: number }

/**
 * Complete (`\n`-terminated) lines only.
 *
 * A partial tail is deliberately not yielded: it is either a write in progress or a torn tail, and
 * consuming it would advance the watermark past bytes the next append is about to complete.
 */
export function* completeLines(buffer: Buffer): Generator<ShadowLine, void, undefined> {
  let cursor = 0
  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor)
    if (newline === -1) {
      return
    }
    yield { text: buffer.toString('utf8', cursor, newline), endOffset: newline + 1 }
    cursor = newline + 1
  }
}

export function readFileSlice(path: string, from: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const length = Math.max(0, size - from)
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, from + offset)
      if (read <= 0) {
        break
      }
      offset += read
    }
    return offset === length ? buffer : buffer.subarray(0, offset)
  } finally {
    closeSync(fd)
  }
}

export class ShadowRecordError extends Error {
  constructor(
    readonly reason: 'unsupported_version' | 'invalid_record',
    message: string
  ) {
    super(message)
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Rebuild the record a line describes.
 *
 * Throws rather than filling defaults: a line that cannot be rebuilt means this build and the writer
 * disagree, and a half-invented record would be worse than stopping.
 */
export function incidentRecordFromShadowLine(text: string): IncidentRecord {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ShadowRecordError('invalid_record', 'shadow line is not an object')
  }
  const line = parsed as Partial<ShadowRecord> & Record<string, unknown>
  if (line.v !== INCIDENT_SHADOW_VERSION) {
    throw new ShadowRecordError('unsupported_version', `shadow version ${String(line.v)}`)
  }
  const id = asString(line.id)
  const sourceId = asString(line.source_id)
  const facet = asString(line.facet)
  const hostId = asString(line.host_id)
  const fingerprint = asString(line.fingerprint)
  if (!id || !sourceId || !facet || !hostId || !fingerprint) {
    throw new ShadowRecordError('invalid_record', 'shadow line is missing its key')
  }
  if (!isIncidentSourceKind(line.source_kind)) {
    throw new ShadowRecordError('invalid_record', 'shadow line has an unknown source_kind')
  }
  if (!isIncidentClass(line.class) || !isIncidentStatus(line.status)) {
    throw new ShadowRecordError('invalid_record', 'shadow line has an unknown class/status')
  }
  if (typeof line.created_at !== 'number' || !Number.isFinite(line.created_at)) {
    throw new ShadowRecordError('invalid_record', 'shadow line has no created_at')
  }
  const evidence = line.evidence
  return {
    id,
    sourceKind: line.source_kind,
    sourceId,
    facet,
    hostId,
    worktreeId: asString(line.worktree_id),
    runId: asString(line.run_id),
    taskId: asString(line.task_id),
    dispatchId: asString(line.dispatch_id),
    agentSessionId: asString(line.agent_session_id),
    ptyIncarnationId: asString(line.pty_incarnation_id),
    class: line.class,
    status: line.status,
    exitCause: (line.exit_cause ?? null) as IncidentRecord['exitCause'],
    fingerprint,
    evidence:
      typeof evidence === 'object' && evidence !== null
        ? (evidence as IncidentRecord['evidence'])
        : { pointers: [], unknownBoundaries: [] },
    summary: typeof line.summary === 'string' ? line.summary : '',
    createdAt: line.created_at
  }
}

