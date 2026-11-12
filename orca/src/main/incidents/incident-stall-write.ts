// Writing a stall incident (issue-sedimentation.md v2.4 §7.2, M3-4).
//
// Off by default. The design's grayscale rule is explicit: first observe the ages and the would-stall
// count, confirm the list is not wall-to-wall, and only then let it write. So this module is the
// switch's other half — the predicate above decides, this decides whether that decision is allowed
// to become a row.
//
// When on, the record goes through exactly the same path as a crash: `persistIncidentRecord` (shadow
// first, then the idempotent insert), the same sanitize layer, the same immutable row, and the same
// `untriaged` entry status. A stall is a fact, not a verdict.

import type { IncidentRecord } from './incident-types'
import { incidentFingerprint } from './incident-key'
import { mintIncidentId, persistIncidentRecord } from './incident-writer'
import { resolveLocalHostId } from './incidents-paths'
import type { IncidentStore } from './incident-store'
import type { StallDecision, StallPaneFacts } from './incident-stall-decision'

/** §7.2 grayscale switch. Anything but the exact word `on` keeps the writer off. */
export const STALL_WRITE_ENV = 'INCIDENT_STALL_WRITE'

export function stallWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STALL_WRITE_ENV] === 'on'
}

export type StallWriteContext = {
  facts: StallPaneFacts
  decision: StallDecision
  hostId?: string
  now?: number
  id?: string
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}

/**
 * Build the row.
 *
 * `source_id` is `<paneKey>:<stateStartedAt>`: the state's epoch is the idempotency key (§6.2.1), so
 * one stuck stretch is one row even if the sampler sees it every minute, and a pane that recovers and
 * stalls again gets a fresh epoch and therefore a fresh row.
 */
export function buildStallIncidentRecord(context: StallWriteContext): IncidentRecord {
  const { facts, decision } = context
  const stateStartedAt = facts.stateStartedAt
  return {
    id: context.id ?? mintIncidentId(),
    sourceKind: 'status_stall',
    sourceId: `${facts.paneKey}:${stateStartedAt}`,
    facet: 'stall',
    hostId: context.hostId ?? resolveLocalHostId(),
    worktreeId: null,
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: 'no_progress',
    status: 'untriaged',
    exitCause: null,
    fingerprint: incidentFingerprint({
      class: 'no_progress',
      sourceKind: 'status_stall',
      facet: 'stall',
      signature: [`state:${facts.state}`, `threshold:${decision.thresholds.stallMs}`]
    }),
    evidence: {
      pointers: [],
      unknownBoundaries: [
        '无进展判定来自状态时间戳（stateStartedAt / turnStartedAt），不是语义验收；agent 可能在等待而不报状态。',
        '同一 pane 恢复后以新的 stateStartedAt 重新计数，旧记录不会被续写。'
      ],
      code: `stall:${facts.state}`
    },
    summary:
      `No progress for ${minutes(decision.ageMs)}m in state "${facts.state}" on ${facts.paneKey} ` +
      `(threshold ${minutes(decision.thresholds.stallMs)}m)`,
    createdAt: context.now ?? Date.now()
  }
}

export type StallWriteResult = {
  outcome: 'inserted' | 'duplicate' | 'capacity_limited' | 'read_only' | 'skipped'
  id: string | null
  reason?: string
}

/**
 * Persist one stall, or report why it was not persisted.
 *
 * Never throws: the sampler calls this from a timer, and a diagnostics writer that can throw on a
 * timer is a crash generator. Callers count the outcomes for the coverage surface.
 */
export function writeStallIncident(options: {
  store: IncidentStore | null
  facts: StallPaneFacts
  decision: StallDecision
  hostId?: string
  now?: number
  userDataPath?: string | null
}): StallWriteResult {
  if (options.store === null) {
    return { outcome: 'skipped', id: null, reason: 'store_unavailable' }
  }
  try {
    const record = buildStallIncidentRecord({
      facts: options.facts,
      decision: options.decision,
      ...(options.hostId === undefined ? {} : { hostId: options.hostId }),
      ...(options.now === undefined ? {} : { now: options.now })
    })
    const { result } = persistIncidentRecord(options.store, record, {
      userDataPath: options.userDataPath
    })
    if (result.outcome === 'inserted') {
      return { outcome: 'inserted', id: result.id ?? record.id }
    }
    if (result.outcome === 'duplicate') {
      return { outcome: 'duplicate', id: result.id }
    }
    if (result.outcome === 'capacity_limited') {
      return { outcome: 'capacity_limited', id: null, reason: result.limitedBy }
    }
    if (result.outcome === 'read_only') {
      return { outcome: 'read_only', id: null }
    }
    return { outcome: 'skipped', id: null, reason: result.reason ?? result.outcome }
  } catch (error) {
    return {
      outcome: 'skipped',
      id: null,
      reason: error instanceof Error ? `stall_write_threw:${error.name}` : 'stall_write_threw'
    }
  }
}
