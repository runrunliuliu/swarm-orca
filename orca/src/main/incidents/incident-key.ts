// Idempotency keys with an epoch (issue-sedimentation.md v2.2 §6.2.1).
//
// `UNIQUE(source_kind, source_id, facet)` is only correct when `source_id` already carries the
// epoch of the thing being described. A bare entity id silently swallows a second, genuinely
// different failure — the epoched forms below are the four cases §6.2.1 names, and each exists
// because a real duplicate-key loss was possible without it:
//
//   * a pane that stalls, recovers, then stalls again  -> the second stall vanished
//   * one dispatch with two acceptance rules           -> the rules overwrote each other
//   * the same tool error in two turns                 -> one turn's error absorbed the other
//   * a PTY exit                                       -> incarnation id is already an epoch
//
// The epoch is always taken from an upstream field that already moves monotonically
// (incarnation id, `stateStartedAt`, turn, attempt). Nothing here mints a counter, and the store
// never "smart-dedupes": the writer must hand it a complete key.

import { createHash } from 'node:crypto'
import type { IncidentClass, IncidentSourceKind } from './incident-types'

export type IncidentKeyInput =
  /** §7.1: one PTY incarnation dies once; the incarnation id *is* the epoch. */
  | { kind: 'pty_exit'; ptyIncarnationId: string | null | undefined }
  /** §7.2: a pane may stall under several `stateStartedAt` values; each is its own incident. */
  | {
      kind: 'status_stall'
      paneKey: string | null | undefined
      stateStartedAt: number | string | null | undefined
    }
  /** §7.3: the same tool error in two turns is two incidents; the window start bounds a burst. */
  | {
      kind: 'tool_error'
      sessionId: string | null | undefined
      turn: number | string | null | undefined
      code: string | null | undefined
      windowStart: number | string | null | undefined
    }
  /** §7.4: per-rule facet, so two rules on one dispatch do not overwrite each other. */
  | {
      kind: 'acceptance'
      dispatchId: string | null | undefined
      attempt: number | string | null | undefined
      ruleId: string | null | undefined
    }
  /** §7.5: the caller's request id is the idempotency key for a self-report. */
  | { kind: 'self_report'; requestId: string | null | undefined }

export type IncidentKeyRejection =
  /** No epoch was supplied — the caller would otherwise get bare-entity dedupe. */
  | 'missing_epoch'
  /** An epoch was supplied but is not a usable value (blank, non-finite, or containing a separator). */
  | 'invalid_epoch'
  /** The stable entity id is missing. */
  | 'missing_entity'
  /** The stable entity id contains whitespace or the `:` separator. */
  | 'invalid_entity'

export type IncidentKey =
  | {
      ok: true
      sourceKind: IncidentSourceKind
      sourceId: string
      facet: string
      /** Ordered identity parts for the fingerprint; never part of the unique key. */
      fingerprintParts: string[]
    }
  | { ok: false; reason: IncidentKeyRejection }

const SEPARATOR = ':'
const WHITESPACE = /\s/

/**
 * `tab:leaf` is itself composite, so a pane key is the one entity allowed to contain one separator.
 * Everything else is a single opaque token.
 */
const PANE_KEY = /^[^\s:]+:[^\s:]+$/

function cleanEntity(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 512) {
    return null
  }
  if (WHITESPACE.test(trimmed) || trimmed.includes(SEPARATOR)) {
    return null
  }
  return trimmed
}

function cleanPaneKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!PANE_KEY.test(trimmed) || trimmed.length > 512) {
    return null
  }
  return trimmed
}

/**
 * Numbers become their decimal form so an upstream numeric epoch and the same epoch serialized as a
 * string (`"1700000000000"`) cannot produce two rows for one failure.
 */
function cleanEpoch(value: number | string | null | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? String(value) : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 512) {
    return null
  }
  if (WHITESPACE.test(trimmed) || trimmed.includes(SEPARATOR)) {
    return null
  }
  return trimmed
}

/**
 * Build the key for one incident, or say precisely which input made it unbuildable.
 *
 * Callers in a failure path (the PTY exit writer) must treat `{ ok: false }` as "record nothing and
 * report the reason", never as "fall back to a bare id": a key without its epoch is exactly the
 * data loss §6.2.1 exists to prevent.
 */
export function buildIncidentKey(input: IncidentKeyInput): IncidentKey {
  switch (input.kind) {
    case 'pty_exit': {
      const epoch = cleanEpoch(input.ptyIncarnationId)
      if (epoch === null) {
        return {
          ok: false,
          reason:
            input.ptyIncarnationId === null || input.ptyIncarnationId === undefined
              ? 'missing_epoch'
              : 'invalid_epoch'
        }
      }
      return {
        ok: true,
        sourceKind: 'pty_exit',
        sourceId: epoch,
        facet: 'exit',
        fingerprintParts: ['pty_exit', 'exit', `incarnation:${epoch}`]
      }
    }
    case 'status_stall': {
      const paneKey = cleanPaneKey(input.paneKey)
      if (paneKey === null) {
        return { ok: false, reason: 'missing_entity' }
      }
      const epoch = cleanEpoch(input.stateStartedAt)
      if (epoch === null) {
        return {
          ok: false,
          reason:
            input.stateStartedAt === null || input.stateStartedAt === undefined
              ? 'missing_epoch'
              : 'invalid_epoch'
        }
      }
      return {
        ok: true,
        sourceKind: 'status_stall',
        sourceId: `${paneKey}${SEPARATOR}${epoch}`,
        facet: 'stall',
        fingerprintParts: ['status_stall', 'stall', `pane:${paneKey}`, `stateStartedAt:${epoch}`]
      }
    }
    case 'tool_error': {
      const sessionId = cleanEntity(input.sessionId)
      if (sessionId === null) {
        return { ok: false, reason: 'missing_entity' }
      }
      const turn = cleanEpoch(input.turn)
      const code = cleanEntity(input.code)
      const windowStart = cleanEpoch(input.windowStart)
      // `turn`, `code` and the window are all part of the epoch: any one of them missing collapses
      // distinct turns of the same tool failure into one row.
      if (turn === null || code === null || windowStart === null) {
        const anyMissing =
          input.turn === null ||
          input.turn === undefined ||
          input.windowStart === null ||
          input.windowStart === undefined
        return { ok: false, reason: anyMissing ? 'missing_epoch' : 'invalid_epoch' }
      }
      return {
        ok: true,
        sourceKind: 'tool_error',
        sourceId: [sessionId, turn, code, windowStart].join(SEPARATOR),
        facet: `tool:${code}`,
        fingerprintParts: ['tool_error', `code:${code}`, `tool-facet:${code}`]
      }
    }
    case 'acceptance': {
      const dispatchId = cleanEntity(input.dispatchId)
      if (dispatchId === null) {
        return { ok: false, reason: 'missing_entity' }
      }
      const attempt = cleanEpoch(input.attempt)
      if (attempt === null) {
        return {
          ok: false,
          reason:
            input.attempt === null || input.attempt === undefined ? 'missing_epoch' : 'invalid_epoch'
        }
      }
      const ruleId = cleanEntity(input.ruleId)
      if (ruleId === null) {
        return { ok: false, reason: 'missing_entity' }
      }
      return {
        ok: true,
        sourceKind: 'acceptance',
        sourceId: `${dispatchId}${SEPARATOR}${attempt}`,
        facet: `rule:${ruleId}`,
        fingerprintParts: ['acceptance', `rule:${ruleId}`]
      }
    }
    case 'self_report': {
      const requestId = cleanEntity(input.requestId)
      if (requestId === null) {
        return {
          ok: false,
          reason:
            input.requestId === null || input.requestId === undefined
              ? 'missing_epoch'
              : 'invalid_entity'
        }
      }
      return {
        ok: true,
        sourceKind: 'self_report',
        sourceId: requestId,
        facet: 'report',
        fingerprintParts: ['self_report', `request:${requestId}`]
      }
    }
  }
}

/**
 * Cluster fingerprint: proximity only, never identity (§6.2 keeps it out of the unique key).
 *
 * The parts are the *shape* of the failure — class, source kind, facet and the writer's own
 * signature (exit kind/signal, error code) — so two crashes of different incarnations land in one
 * cluster while still being two distinct rows.
 */
export function incidentFingerprint(parts: {
  class: IncidentClass
  sourceKind: IncidentSourceKind
  facet: string
  signature: readonly string[]
}): string {
  return createHash('sha256')
    .update([parts.class, parts.sourceKind, parts.facet, ...parts.signature].join('|'), 'utf8')
    .digest('hex')
}
