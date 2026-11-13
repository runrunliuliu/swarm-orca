// `orca incident report`: the executor's own report (§7.5, T3).
//
// A self-report is the one class of incident whose facts nobody but the reporter has, so it is
// recorded rather than filtered — but it is recorded at the lowest rank: always `untriaged`, always
// with the "not independently verified" boundary, and never `confirmed` (§5: the reporter cannot
// sign their own acceptance).
//
// It goes through the same store, the same key rule and the same shadow as a crash. The difference
// is only who provides the fields — and that `--evidence` pointers are checked to exist here, since
// a pointer to a file that is not there is worse than no pointer (it looks like evidence).

import { createHash, randomUUID } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import {
  isIncidentClass,
  type IncidentClass,
  type IncidentEvidence,
  type IncidentEvidencePointer,
  type IncidentRecord
} from './incident-types'
import { buildIncidentKey, incidentFingerprint } from './incident-key'
import { mintIncidentId, persistIncidentRecord } from './incident-writer'
import { sanitizeEvidence, sanitizeText } from './incident-sanitize'
import { resolveLocalHostId } from './incidents-paths'
import type { IncidentStore } from './incident-store'

const HASH_CHUNK_BYTES = 1024 * 1024
const MAX_SUMMARY_CHARS = 800

export type SelfReportInput = {
  class: IncidentClass
  /** Required (§7.5). Normalized into the record and the fingerprint. */
  code: string
  summary?: string
  repro?: string
  evidencePointers?: IncidentEvidencePointer[]
  /** Defaults to this request's id, so two invocations are two reports unless the caller pins it. */
  sourceId?: string
  hostId?: string
  createdAt?: number
  id?: string
}

/**
 * Per-file cap (M2-C5). A pointer has to be hashable within the command's lifetime; past this size the
 * user gets a typed refusal instead of a command that looks hung, and nothing is silently skipped.
 */
export const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024

export class EvidenceFileError extends Error {
  constructor(
    readonly reason:
      | 'evidence_missing'
      | 'evidence_unreadable'
      | 'evidence_not_a_file'
      | 'evidence_too_large',
    readonly path: string,
    readonly bytes?: number
  ) {
    super(`evidence ${reason}: ${path}`)
  }
}

/**
 * Hash and size one evidence file into a pointer (§6.3: pointers only, never bodies).
 *
 * Streaming, constant memory: an evidence path is often a multi-hundred-MB transcript, and the only
 * thing the record keeps from it is the digest and the size.
 */
export function evidencePointerForFile(
  path: string,
  kind: IncidentEvidencePointer['kind'] = 'transcript'
): IncidentEvidencePointer {
  let size: number
  try {
    const info = statSync(path)
    if (!info.isFile()) {
      throw new EvidenceFileError('evidence_not_a_file', path)
    }
    size = info.size
    if (size > MAX_EVIDENCE_BYTES) {
      throw new EvidenceFileError('evidence_too_large', path, size)
    }
  } catch (error) {
    if (error instanceof EvidenceFileError) {
      throw error
    }
    throw new EvidenceFileError('evidence_missing', path)
  }
  const digest = createHash('sha256')
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    throw new EvidenceFileError('evidence_unreadable', path)
  }
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) {
        break
      }
      digest.update(buffer.subarray(0, read))
    }
  } catch {
    throw new EvidenceFileError('evidence_unreadable', path)
  } finally {
    closeSync(fd)
  }
  return { kind, path, sha256: digest.digest('hex'), bytes: size }
}

function normalizeCode(code: string): string {
  return code.trim().slice(0, 200)
}

/**
 * Build the immutable row.
 *
 * `code` and `repro` ride in the evidence body instead of new columns: §6.2's schema is frozen for
 * M2 (the alternative is a migration for two text fields nobody queries), and the renderer reads them
 * from there. The code is part of the fingerprint, so two reports of the same code cluster.
 */
export function buildSelfReportRecord(input: SelfReportInput): IncidentRecord {
  if (!isIncidentClass(input.class)) {
    throw new Error('invalid_incident_class')
  }
  const code = normalizeCode(input.code)
  if (code.length === 0) {
    throw new Error('missing_incident_code')
  }
  const sourceId = input.sourceId?.trim() ?? ''
  // A bare timestamp collided for two reports in the same millisecond, which silently deduped them;
  // the random tail keeps "one invocation = one report" true without asking the caller for an id.
  const key = buildIncidentKey({
    kind: 'self_report',
    requestId:
      sourceId.length > 0
        ? sourceId
        : `request_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
  })
  if (!key.ok) {
    throw new Error(`invalid_incident_key:${key.reason}`)
  }
  const pointers = sanitizeEvidence({ pointers: input.evidencePointers ?? [] }).pointers
  const unknownBoundaries = [
    '自报（T3）：class / code / 复现由报告者提供，未经独立复核，不得作为已确认 bug。'
  ]
  if (pointers.length === 0) {
    unknownBoundaries.push('未附证据指针：报告者未提供 --evidence。')
  }
  const evidence = sanitizeEvidence({
    pointers,
    unknownBoundaries,
    code,
    ...(input.repro ? { repro: input.repro } : {})
  }) satisfies IncidentEvidence
  const summaryBase = input.summary?.trim() ?? ''
  const summary = sanitizeText(
    `${code}${summaryBase.length > 0 ? `: ${summaryBase}` : ''}`,
    MAX_SUMMARY_CHARS
  )
  return {
    id: input.id ?? mintIncidentId(),
    sourceKind: key.sourceKind,
    sourceId: key.sourceId,
    facet: key.facet,
    hostId: input.hostId ?? resolveLocalHostId(),
    worktreeId: null,
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: input.class,
    status: 'untriaged',
    exitCause: null,
    fingerprint: incidentFingerprint({
      class: input.class,
      sourceKind: key.sourceKind,
      facet: key.facet,
      signature: [`code:${code}`]
    }),
    evidence,
    summary,
    createdAt: input.createdAt ?? Date.now()
  }
}

export type SelfReportResult = {
  outcome: 'inserted' | 'duplicate' | 'capacity_limited' | 'read_only' | 'failed'
  id: string | null
  reason?: string
  shadow: 'written' | 'failed' | 'skipped'
}

/**
 * Write a self-report through the shared path: shadow first, then the idempotent insert.
 *
 * `shadowMode: 'append'` is for the CLI process, which writes one line per command instead of
 * holding the runtime's rotating sink open.
 */
export function recordSelfReportTo(
  store: IncidentStore,
  input: SelfReportInput,
  options: {
    userDataPath?: string | null
    shadow?: boolean
    shadowMode?: 'sink' | 'append'
    db?: Database.Database
  } = {}
): SelfReportResult {
  const record = buildSelfReportRecord(input)
  const { result, shadow } = persistIncidentRecord(store, record, options)
  return {
    outcome: result.outcome === 'invalid_record' ? 'failed' : result.outcome,
    id: result.id ?? (result.outcome === 'inserted' ? record.id : null),
    reason: result.reason,
    shadow
  }
}
