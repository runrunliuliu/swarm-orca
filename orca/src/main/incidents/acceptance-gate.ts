// The settlement gate (issue-sedimentation.md v2.6 §8, M5-3).
//
// One gate, one place: `reconcileLifecycleMessage` is the only function that settles a `worker_done`
// (every ingestion path — point-to-point send, unread check, federation import, legacy completion,
// coordinator tick — funnels through it), so the gate lives immediately before `settleWorkerReport`.
//
// It runs NO command. Execution happened earlier, outside any transaction (see
// evaluateAcceptanceBeforeWorkerDone), and this reads the stored verdicts. That is what §8's "the check
// must happen before completeDispatch, outside the lifecycle write transaction" requires: the slow part
// is already a value by the time the transaction opens.
//
// Blocked means: do not settle, and leave something a person can see and own. The stop row is that
// something; the incident is its durable proof. Neither touches the dispatch's status — this module
// never calls `failDispatch`, and `dispatch-completion` remains the only writer of a dispatch outcome.

import type Database from '../sqlite/sync-database'
import { listAcceptanceRules, listAcceptanceVerdicts } from './dispatch-acceptance-store'
import {
  acceptanceGateState,
  getAcceptanceStop,
  openAcceptanceStop
} from './dispatch-acceptance-stops'
import type { IncidentRecord } from './incident-types'
import { buildIncidentKey, incidentFingerprint } from './incident-key'
import { mintIncidentId } from './incident-writer'
import { resolveLocalHostId } from './incidents-paths'
import type { IncidentStore } from './incident-store'

export type AcceptanceGateVerdict = 'no_rules' | 'passed' | 'blocked'

export type AcceptanceGateContext = {
  /** Incidents database (declarations + verdicts + stops). */
  db: Database.Database
  store: IncidentStore
  /** How many attempts this dispatch has had; part of the incident's epoch (§6.2.1). */
  attempt?: number
  now?: number
  hostId?: string
}

function ruleSummary(detail: string | null): string {
  return detail === null ? 'no verdict detail' : detail
}

/**
 * Write the incident(s) for a blocked dispatch, idempotently.
 *
 * One incident per (dispatch attempt, rule): a second rule failing later must not overwrite the first
 * one's row, and a retry of the same attempt must not duplicate it — the key's epoch is the attempt.
 */
export function openAcceptanceIncidents(
  context: AcceptanceGateContext,
  dispatchId: string,
  rules: { ruleId: string; verdict: 'failed' | 'undeterminable' | 'not_evaluated'; detail: string | null }[]
): string | null {
  const now = context.now ?? Date.now()
  const attempt = context.attempt ?? 1
  let firstIncidentId: string | null = null
  for (const rule of rules) {
    const key = buildIncidentKey({ kind: 'acceptance', dispatchId, attempt, ruleId: rule.ruleId })
    if (!key.ok) {
      continue
    }
    const record: IncidentRecord = {
      id: mintIncidentId(),
      sourceKind: key.sourceKind,
      sourceId: key.sourceId,
      facet: key.facet,
      hostId: context.hostId ?? resolveLocalHostId(),
      worktreeId: null,
      runId: null,
      taskId: null,
      dispatchId,
      agentSessionId: null,
      ptyIncarnationId: null,
      class: 'acceptance_failed',
      status: 'untriaged',
      exitCause: null,
      fingerprint: incidentFingerprint({
        class: 'acceptance_failed',
        sourceKind: key.sourceKind,
        facet: key.facet,
        signature: [`rule:${rule.ruleId}`, `verdict:${rule.verdict}`]
      }),
      evidence: {
        pointers: [],
        unknownBoundaries: [
          `dispatch ${dispatchId} 的 acceptance 规则 ${rule.ruleId} 结果：${rule.verdict}（${ruleSummary(rule.detail)}）。`,
          '判定由主进程在结算事务之外执行；命令输出只存指纹与字节数，正文不落库。',
          '本条不直接 fail dispatch：dispatch 保持原状态，停点由 acceptance_pending 承担，需人工/owner 解析。'
        ],
        code: `acceptance_rule:${rule.ruleId}`,
        repro: `orca incident acceptance show --dispatch ${dispatchId}`
      },
      summary:
        `Acceptance rule ${rule.ruleId} ${rule.verdict} for dispatch ${dispatchId}` +
        ` (${ruleSummary(rule.detail)})`,
      createdAt: now
    }
    const inserted = context.store.insertIncident(record)
    if (firstIncidentId === null) {
      firstIncidentId = inserted.id ?? record.id
    }
  }
  return firstIncidentId
}

/**
 * The gate. Returns `blocked` with the stop opened; callers must not settle.
 *
 * `no_rules` is the regression path: a dispatch with no declaration behaves exactly as before this
 * milestone.
 */
export function gateDispatchSettlement(
  context: AcceptanceGateContext,
  dispatchId: string
): AcceptanceGateVerdict {
  const now = context.now ?? Date.now()
  const state = acceptanceGateState(context.db, dispatchId)
  if (state.state === 'no_rules' || state.state === 'passed') {
    return state.state
  }
  const stop = getAcceptanceStop(context.db, dispatchId)
  if (stop?.state === 'rejected') {
    // A rejected stop is a terminal operator decision; the dispatch stays unsettled and no new
    // incident is written (the decision is the record).
    return 'blocked'
  }
  const rules = new Map(listAcceptanceRules(context.db, dispatchId).map((rule) => [rule.ruleId, rule]))
  const verdicts = new Map(listAcceptanceVerdicts(context.db, dispatchId).map((v) => [v.ruleId, v]))
  const blockedRules = [...state.failedRules, ...state.notEvaluatedRules].map((ruleId) => {
    const verdict = verdicts.get(ruleId)
    if (!verdict) {
      return { ruleId, verdict: 'not_evaluated' as const, detail: 'rule has not been evaluated yet' }
    }
    return {
      ruleId,
      verdict: verdict.verdict as 'failed' | 'undeterminable',
      detail: verdict.detail
    }
  })
  // `rules` is read only to keep the incident set stable when a rule is deleted between two calls.
  const known = blockedRules.filter((entry) => rules.has(entry.ruleId))
  const incidentId = openAcceptanceIncidents(context, dispatchId, known.length > 0 ? known : blockedRules)
  openAcceptanceStop(context.db, { dispatchId, incidentId, now })
  return 'blocked'
}
