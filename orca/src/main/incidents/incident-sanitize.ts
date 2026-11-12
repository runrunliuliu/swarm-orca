// One sanitize pass for everything that reaches storage (issue-sedimentation.md v2.3 §6.3, M2-C2).
//
// Before this module there were three partial answers: the store redacted `summary`, the shadow
// redacted `summary` again, and `evidence` (repro, boundary strings, pointer paths) went in as the
// caller wrote it. A self-report could therefore smuggle a token into `--repro`, and a shadow line is
// just a file on disk that anyone can append to — so replay had to assume the worst too.
//
// The rule now: every consumer calls `sanitizeIncidentRecord` (or the evidence helper) before the
// record is written, replayed or rendered. Redaction is idempotent, so overlapping calls are free.
//
// Paths are redacted as well. That can technically weaken a pointer (a token-shaped filename becomes
// a placeholder), but a pointer that carries a secret is worse than a pointer an operator has to
// re-derive, and §16 forbids credentials reaching the store.

import { redactString } from '../observability/redactor'
import type {
  IncidentEvidence,
  IncidentEvidencePointer,
  IncidentRecord
} from './incident-types'

const MAX_SUMMARY_CHARS = 2000
const MAX_PATH_CHARS = 4096
const MAX_TEXT_CHARS = 2000
const MAX_BOUNDARIES = 50
const MAX_POINTERS = 64
const POINTER_KINDS: ReadonlySet<string> = new Set([
  'transcript',
  'status_snapshot',
  'events',
  'command_output',
  'other'
])

/** Redact + bound a free-text field. Idempotent: the redactor's string passes are idempotent. */
export function sanitizeText(value: unknown, maxChars = MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') {
    return ''
  }
  return redactString(value).slice(0, maxChars)
}

export function sanitizePointer(pointer: unknown): IncidentEvidencePointer | null {
  if (typeof pointer !== 'object' || pointer === null) {
    return null
  }
  const raw = pointer as Record<string, unknown>
  const path = sanitizeText(raw.path, MAX_PATH_CHARS)
  if (path.length === 0) {
    return null
  }
  const kind = typeof raw.kind === 'string' && POINTER_KINDS.has(raw.kind) ? raw.kind : 'other'
  const sha256 = typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256) ? raw.sha256 : undefined
  const pointerOut: IncidentEvidencePointer = {
    kind: kind as IncidentEvidencePointer['kind'],
    path
  }
  if (sha256) {
    pointerOut.sha256 = sha256
  }
  if (typeof raw.bytes === 'number' && Number.isSafeInteger(raw.bytes) && raw.bytes >= 0) {
    pointerOut.bytes = raw.bytes
  }
  if (typeof raw.startOffset === 'number' && Number.isSafeInteger(raw.startOffset) && raw.startOffset >= 0) {
    pointerOut.startOffset = raw.startOffset
  }
  if (typeof raw.endOffset === 'number' && Number.isSafeInteger(raw.endOffset) && raw.endOffset >= 0) {
    pointerOut.endOffset = raw.endOffset
  }
  if (typeof raw.lineWindow === 'number' && Number.isSafeInteger(raw.lineWindow) && raw.lineWindow > 0) {
    pointerOut.lineWindow = raw.lineWindow
  }
  if (raw.truncated === true) {
    pointerOut.truncated = true
  }
  return pointerOut
}

export function sanitizeEvidence(evidence: unknown): IncidentEvidence {
  if (typeof evidence !== 'object' || evidence === null) {
    return { pointers: [], unknownBoundaries: [] }
  }
  const raw = evidence as Record<string, unknown>
  const pointers = Array.isArray(raw.pointers)
    ? raw.pointers
        .slice(0, MAX_POINTERS)
        .map(sanitizePointer)
        .filter((pointer): pointer is IncidentEvidencePointer => pointer !== null)
    : []
  const unknownBoundaries = Array.isArray(raw.unknownBoundaries)
    ? raw.unknownBoundaries
        .slice(0, MAX_BOUNDARIES)
        .map((entry) => sanitizeText(entry))
        .filter((entry) => entry.length > 0)
    : []
  const out: IncidentEvidence = { pointers, unknownBoundaries }
  const digest = sanitizeText(raw.agentIdentityDigest, 256)
  if (digest.length > 0) {
    out.agentIdentityDigest = digest
  }
  const code = sanitizeText(raw.code, 200)
  if (code.length > 0) {
    out.code = code
  }
  const repro = sanitizeText(raw.repro)
  if (repro.length > 0) {
    out.repro = repro
  }
  return out
}

/**
 * The single entry point: summary, evidence — and nothing else is free text in a record.
 *
 * Field names, ids and numbers are left alone: they are keys, and redacting a key would break the
 * idempotency the store is built on.
 */
export function sanitizeIncidentRecord(record: IncidentRecord): IncidentRecord {
  return {
    ...record,
    summary: sanitizeText(record.summary, MAX_SUMMARY_CHARS),
    evidence: sanitizeEvidence(record.evidence)
  }
}
