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
import { buildIncidentKey, incidentFingerprint } from './incident-key'
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
 * Build the row, or refuse it.
 *
 * The key comes from `buildIncidentKey({kind:'status_stall', paneKey, stateStartedAt})`, not from
 * string concatenation (M3-C2): the shared builder is what validates the pane key and the epoch and
 * what produces `source_id = <paneKey>:<stateStartedAt>`. A malformed pane key or a non-finite epoch
 * must be *refused*, because a hand-built id would happily store `"a:b:c:NaN"` and then never dedupe.
 */
export function buildStallIncidentRecord(
  context: StallWriteContext
): { ok: true; record: IncidentRecord } | { ok: false; reason: string } {
  const { facts, decision } = context
  const key = buildIncidentKey({
    kind: 'status_stall',
    paneKey: facts.paneKey,
    stateStartedAt: facts.stateStartedAt
  })
  if (!key.ok) {
    return { ok: false, reason: `status_stall_key_${key.reason}` }
  }
  return {
    ok: true,
    record: {
      id: context.id ?? mintIncidentId(),
      sourceKind: key.sourceKind,
      sourceId: key.sourceId,
      facet: key.facet,
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
        sourceKind: key.sourceKind,
        facet: key.facet,
        signature: [`state:${facts.state}`, `threshold:${decision.thresholds.stallMs}`]
      }),
      evidence: {
        pointers: [],
        unknownBoundaries: [
          '判定依据是状态行的语义事件时钟（evidenceObservedAt）或它在缺失时的 stateStartedAt 回退，' +
            `本次 ageBasis=${decision.ageBasis}；这不是语义验收，agent 可能在等待而不报状态。`,
          '同一 pane 恢复后以新的 stateStartedAt 重新计数，旧记录不会被续写。'
        ],
        code: `stall:${facts.state}`
      },
      summary:
        `No semantic event for ${minutes(decision.ageMs)}m in state "${facts.state}" on ` +
        `${facts.paneKey} (threshold ${minutes(decision.thresholds.stallMs)}m, ` +
        `ageBasis=${decision.ageBasis})`,
      createdAt: context.now ?? Date.now()
    }
  }
}

export type StallWriteResult = {
  outcome: 'inserted' | 'duplicate' | 'capacity_limited' | 'read_only' | 'key_rejected' | 'skipped'
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
    const built = buildStallIncidentRecord({
      facts: options.facts,
      decision: options.decision,
      ...(options.hostId === undefined ? {} : { hostId: options.hostId }),
      ...(options.now === undefined ? {} : { now: options.now })
    })
    if (!built.ok) {
      // A rejected key is not a silent skip: the caller counts it so coverage can show it (M3-C2).
      return { outcome: 'key_rejected', id: null, reason: built.reason }
    }
    const record = built.record
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
