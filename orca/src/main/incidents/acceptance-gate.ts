// The settlement gate (issue-sedimentation.md v2.6 §8, M5-3; M5 review C1/C3/C7).
//
// One gate, one place: every `worker_report` settlement calls `decideWorkerReportAcceptance` before it
// opens its write transaction, and `settleWorkerReportInTransaction` *requires* that decision as a
// parameter — federation import and legacy lifecycle cannot settle without one because the compiler
// says so. Operator maintenance paths (`settleActiveDispatchesForTask`, `completeActiveDispatchesForTask`,
// the low-level completion) use `decideMaintenanceAcceptance`, which allows an explicit, recorded
// override and nothing else.
//
// It runs NO command. Execution happened earlier, outside any transaction (see
// evaluateAcceptanceForDispatch), and this reads the stored verdicts. That is what §8's "the check
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
  openAcceptanceStop,
  recordAcceptanceOverride,
  type AcceptanceGateState
} from './dispatch-acceptance-stops'
import type { IncidentRecord } from './incident-types'
import { buildIncidentKey, incidentFingerprint } from './incident-key'
import { mintIncidentId } from './incident-writer'
import { resolveLocalHostId } from './incidents-paths'
import type { IncidentStore } from './incident-store'

/**
 * The gate's answer.
 *
 * `store_unavailable` is its own verdict, not a flavour of `blocked` (C3): it means "this host has an
 * incidents database we cannot read, so we cannot say whether a declaration exists" — and the answer to
 * that is never "settle anyway". It carries the reason so the log and the CLI can name it.
 */
export type AcceptanceGateOutcome =
  | { verdict: 'no_rules'; blockedRules: [] }
  | { verdict: 'passed'; via: 'verdicts' | 'accepted' | 'overridden'; blockedRules: [] }
  | { verdict: 'blocked'; blockedRules: string[]; incidentId: string | null }
  | { verdict: 'store_unavailable'; blockedRules: []; reason: string }

export type AcceptanceGateContext = {
  /** Incidents database (declarations + verdicts + stops). */
  db: Database.Database
  store: IncidentStore
  /** Whether this store may be written (a newer schema opens read-only). */
  writable?: boolean
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
  let firstIncidentId: string | null = null
  for (const rule of rules) {
    // Why a constant epoch: "Dispatch ID is the Attempt identity" (§6.2.1) — the dispatch id already
    // carries the attempt, so a counter would invent a second epoch that could drift.
    const key = buildIncidentKey({ kind: 'acceptance', dispatchId, attempt: 1, ruleId: rule.ruleId })
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
 * Write the evidence for an operator maintenance bypass (§8 C1).
 *
 * Deliberately a *different* class from `acceptance_failed`: this is not a verdict about the product,
 * it is a record that a person with external authority settled a dispatch without one. The row names
 * the actor, the reason and the rules that were skipped, and it is what `incident acceptance list/show`
 * renders as `overridden`.
 */
export function openAcceptanceOverrideIncident(
  context: AcceptanceGateContext,
  input: { dispatchId: string; actor: string; reason: string; rules: readonly string[] }
): string | null {
  const now = context.now ?? Date.now()
  const key = buildIncidentKey({
    kind: 'acceptance',
    dispatchId: input.dispatchId,
    attempt: 1,
    // The facet is the per-rule discriminator, so `override` cannot collide with a real rule id.
    ruleId: 'override'
  })
  if (!key.ok) {
    return null
  }
  const actor = input.actor.trim().slice(0, 200)
  const reason = input.reason.trim().slice(0, 500)
  const record: IncidentRecord = {
    id: mintIncidentId(),
    sourceKind: key.sourceKind,
    sourceId: key.sourceId,
    facet: key.facet,
    hostId: context.hostId ?? resolveLocalHostId(),
    worktreeId: null,
    runId: null,
    taskId: null,
    dispatchId: input.dispatchId,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: 'acceptance_overridden',
    status: 'untriaged',
    exitCause: null,
    fingerprint: incidentFingerprint({
      class: 'acceptance_overridden',
      sourceKind: key.sourceKind,
      facet: key.facet,
      signature: ['override']
    }),
    evidence: {
      pointers: [],
      unknownBoundaries: [
        `dispatch ${input.dispatchId} 由 operator ${actor} 显式绕过 acceptance 结算；原因：${reason}（actor 为自报，未经验证，§19.1）。`,
        `被绕过的规则：${input.rules.length === 0 ? '（无，规则集不可读或为空）' : input.rules.join(', ')}。`,
        'override 与 accept 是两种状态：本条不代表产品通过验收，只代表外部权威完成了结算。'
      ],
      code: 'acceptance_override',
      repro: `orca incident acceptance show --dispatch ${input.dispatchId}`
    },
    summary:
      `Acceptance overridden for dispatch ${input.dispatchId} by ${actor}: ${reason}` +
      (input.rules.length === 0 ? ' (no rule set read)' : ` (skipped ${input.rules.join(', ')})`),
    createdAt: now
  }
  const inserted = context.store.insertIncident(record)
  return inserted.id ?? record.id
}

/**
 * The gate. Returns the outcome; `blocked` opens the stop and the incident, and callers must not
 * settle.
 *
 * `no_rules` is the regression path: a dispatch with no declaration behaves exactly as before.
 */
export function gateDispatchSettlement(
  context: AcceptanceGateContext,
  dispatchId: string
): AcceptanceGateOutcome {
  const now = context.now ?? Date.now()
  const state = acceptanceGateState(context.db, dispatchId)
  if (state.state === 'no_rules') {
    return { verdict: 'no_rules', blockedRules: [] }
  }
  if (state.state === 'passed') {
    return { verdict: 'passed', via: state.via, blockedRules: [] }
  }
  const stop = getAcceptanceStop(context.db, dispatchId)
  if (stop?.state === 'rejected') {
    // A rejected stop is a terminal operator decision; the dispatch stays unsettled and no new
    // incident is written (the decision is the record).
    return {
      verdict: 'blocked',
      blockedRules: listAcceptanceRules(context.db, dispatchId).map((rule) => rule.ruleId),
      incidentId: stop.incidentId
    }
  }
  const rules = new Map(listAcceptanceRules(context.db, dispatchId).map((rule) => [rule.ruleId, rule]))
  const verdicts = new Map(listAcceptanceVerdicts(context.db, dispatchId).map((v) => [v.ruleId, v]))
  const blockedRules = [...state.failedRules, ...state.notEvaluatedRules].map((ruleId) => {
    const verdict = verdicts.get(ruleId)
    const rule = rules.get(ruleId)
    // A verdict that belongs to a previous revision of the rule is not a verdict about this one (C7).
    if (!verdict || rule === undefined || verdict.ruleDigest !== rule.digest || verdict.ruleDeclaredAt !== rule.createdAt) {
      return { ruleId, verdict: 'not_evaluated' as const, detail: 'rule has not been evaluated for its current revision' }
    }
    return {
      ruleId,
      verdict: verdict.verdict as 'failed' | 'undeterminable',
      detail: verdict.detail
    }
  })
  // `rules` is read only to keep the incident set stable when a rule is deleted between two calls.
  const known = blockedRules.filter((entry) => rules.has(entry.ruleId))
  const incidentId =
    context.writable === false
      ? null
      : openAcceptanceIncidents(context, dispatchId, known.length > 0 ? known : blockedRules)
  if (context.writable !== false) {
    openAcceptanceStop(context.db, { dispatchId, incidentId, now })
  }
  return { verdict: 'blocked', blockedRules: blockedRules.map((entry) => entry.ruleId), incidentId }
}

/**
 * Record an operator maintenance bypass: the stop, the incident, and the rule list in one place.
 *
 * Returns `false` when the evidence could not be written (read-only store), which the caller must
 * treat as "no override" — a bypass without its record is exactly the silent completion the review
 * rejected.
 */
export function recordAcceptanceBypass(
  context: AcceptanceGateContext,
  input: { dispatchId: string; actor: string; reason: string; rules: readonly string[] }
): boolean {
  if (context.writable === false) {
    return false
  }
  const now = context.now ?? Date.now()
  const incidentId = openAcceptanceOverrideIncident(context, { ...input, rules: input.rules })
  recordAcceptanceOverride(context.db, {
    dispatchId: input.dispatchId,
    actor: input.actor,
    reason: input.reason,
    rules: input.rules,
    now
  })
  // Keep the incident id on the stop when one was written; `recordAcceptanceOverride` cannot know it.
  if (incidentId !== null) {
    context.db
      .prepare('UPDATE dispatch_acceptance_stops SET incident_id = ? WHERE dispatch_id = ?')
      .run(incidentId, input.dispatchId)
  }
  return true
}

/** Read-only view for the CLI: the state and the reasons, without the incident body. */
export function describeAcceptanceState(state: AcceptanceGateState): string {
  if (state.state === 'no_rules') {
    return 'no_rules'
  }
  if (state.state === 'passed') {
    return `passed(${state.via})`
  }
  return `blocked(${[...state.failedRules, ...state.notEvaluatedRules].join(',') || 'rules'})`
}
