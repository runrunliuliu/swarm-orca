// Acceptance stops and the gate's read-only decision (issue-sedimentation.md v2.6 §8, M5-3).
//
// Split from the declaration store so each file stays readable: this one owns the *visible stop* and the
// one question settlement asks ("may this dispatch settle?"), and it never runs a command.
//
// Two counters, because the review found one counter answering two questions (C6):
//   * `evaluationAttempts` — how many times the declared command was actually run for this stop;
//   * `gateSeenCount` — how many settlement reads observed the stop (every coordinator tick re-reads an
//     unread worker_done, so this grows monotonically by design and says nothing about retries).
// Both are capped so a stop that nobody resolves cannot overflow its own evidence; `lastSeenAt` keeps
// moving after the cap, which is how "this is still being looked at" stays visible.

import type Database from './../sqlite/sync-database'
import { listAcceptanceRules, listAcceptanceVerdicts } from './dispatch-acceptance-store'

export type AcceptanceStopState = 'pending' | 'accepted' | 'rejected' | 'overridden'

/**
 * Counters stop counting here and keep tracking `lastSeenAt`/`lastError` instead. The number is a
 * display bound, not a policy: 10k evaluations of one rule already means nobody is watching.
 */
export const MAX_ACCEPTANCE_COUNTER = 10_000

export type AcceptanceStop = {
  dispatchId: string
  state: AcceptanceStopState
  incidentId: string | null
  openedAt: number
  updatedAt: number
  actor: string | null
  reason: string | null
  /** Command runs recorded for this stop. */
  evaluationAttempts: number
  /** Settlement reads of this stop. Grows per tick by design; see the header. */
  gateSeenCount: number
  lastSeenAt: number | null
  /** The most recent evaluation/authorization failure, bounded and already a typed reason. */
  lastError: string | null
  /** Rule ids an operator bypassed, when `state === 'overridden'`. */
  overriddenRules: string[]
}

function parseRuleList(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

export function getAcceptanceStop(db: Database.Database, dispatchId: string): AcceptanceStop | null {
  const row = db.prepare('SELECT * FROM dispatch_acceptance_stops WHERE dispatch_id = ?').get(dispatchId)
  if (!row) {
    return null
  }
  return {
    dispatchId: String(row.dispatch_id),
    state: String(row.state) as AcceptanceStopState,
    incidentId: row.incident_id === null ? null : String(row.incident_id),
    openedAt: Number(row.opened_at),
    updatedAt: Number(row.updated_at),
    actor: row.actor === null ? null : String(row.actor),
    reason: row.reason === null ? null : String(row.reason),
    evaluationAttempts: Number(row.evaluation_attempts ?? 0),
    gateSeenCount: Number(row.gate_seen_count ?? 0),
    lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined ? null : Number(row.last_seen_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    overriddenRules: parseRuleList(row.overridden_rules)
  }
}

const TERMINAL_STOP_STATES: readonly AcceptanceStopState[] = ['accepted', 'rejected', 'overridden']

/**
 * Open or refresh the stop. A pending stop counts the settlement reads that observed it; `accepted`,
 * `rejected` and `overridden` are operator decisions and are never overwritten by a later automated
 * failure (only a re-declared rule reopens them — see the declaration store).
 */
export function openAcceptanceStop(
  db: Database.Database,
  input: { dispatchId: string; incidentId: string | null; now: number }
): AcceptanceStop {
  const existing = getAcceptanceStop(db, input.dispatchId)
  if (existing !== null && TERMINAL_STOP_STATES.includes(existing.state)) {
    return existing
  }
  db.prepare(
    `INSERT INTO dispatch_acceptance_stops
       (dispatch_id, state, incident_id, opened_at, updated_at, actor, reason,
        evaluation_attempts, gate_seen_count, last_seen_at, last_error, overridden_rules)
     VALUES (?, 'pending', ?, ?, ?, NULL, NULL, 0, 1, ?, NULL, NULL)
     ON CONFLICT(dispatch_id) DO UPDATE SET
       incident_id = COALESCE(excluded.incident_id, dispatch_acceptance_stops.incident_id),
       updated_at = excluded.updated_at,
       gate_seen_count = MIN(
         dispatch_acceptance_stops.gate_seen_count + 1,
         ${MAX_ACCEPTANCE_COUNTER}
       ),
       last_seen_at = excluded.last_seen_at`
  ).run(input.dispatchId, input.incidentId, input.now, input.now, input.now)
  return getAcceptanceStop(db, input.dispatchId) as AcceptanceStop
}

/**
 * Record that the declared command ran once for this stop (C6).
 *
 * Called by the evaluation path, never by the gate: "we re-read the verdict" is not "we tried again".
 * `error` is a typed reason (spawn failure, timeout, authorization refusal) and is what makes a
 * stop that keeps failing to evaluate visible without reading the incident body.
 */
export function recordAcceptanceEvaluation(
  db: Database.Database,
  input: { dispatchId: string; now: number; error?: string | null }
): AcceptanceStop | null {
  const existing = getAcceptanceStop(db, input.dispatchId)
  if (existing === null) {
    return null
  }
  if (TERMINAL_STOP_STATES.includes(existing.state)) {
    return existing
  }
  db.prepare(
    `UPDATE dispatch_acceptance_stops
        SET evaluation_attempts = MIN(evaluation_attempts + 1, ${MAX_ACCEPTANCE_COUNTER}),
            updated_at = ?,
            last_seen_at = ?,
            last_error = ?
      WHERE dispatch_id = ? AND state = 'pending'`
  ).run(
    input.now,
    input.now,
    input.error === undefined || input.error === null ? existing.lastError : input.error.slice(0, 200),
    input.dispatchId
  )
  return getAcceptanceStop(db, input.dispatchId)
}

export type AcceptanceOverrideInput = {
  dispatchId: string
  actor: string
  reason: string
  /** The rules the bypass skips; empty when the operator overrode without a readable rule set. */
  rules: readonly string[]
  now: number
}

/**
 * Record an operator maintenance bypass (§8 C1).
 *
 * This is not an `accept`: accept says "the product passed the declared check", override says "an
 * operator with external authority settled this without it". Keeping them separate is the whole point
 * of the compromise — the evidence row names the rules that were skipped.
 */
export function recordAcceptanceOverride(
  db: Database.Database,
  input: AcceptanceOverrideInput
): AcceptanceStop {
  const existing = getAcceptanceStop(db, input.dispatchId)
  if (existing !== null && TERMINAL_STOP_STATES.includes(existing.state)) {
    return existing
  }
  db.prepare(
    `INSERT INTO dispatch_acceptance_stops
       (dispatch_id, state, incident_id, opened_at, updated_at, actor, reason,
        evaluation_attempts, gate_seen_count, last_seen_at, last_error, overridden_rules)
     VALUES (?, 'overridden', NULL, ?, ?, ?, ?, 0, 0, ?, NULL, ?)
     ON CONFLICT(dispatch_id) DO UPDATE SET
       state = 'overridden',
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at,
       actor = excluded.actor,
       reason = excluded.reason,
       overridden_rules = excluded.overridden_rules`
  ).run(
    input.dispatchId,
    input.now,
    input.now,
    input.actor.trim().slice(0, 200),
    input.reason.trim().slice(0, 500),
    input.now,
    JSON.stringify([...input.rules])
  )
  return getAcceptanceStop(db, input.dispatchId) as AcceptanceStop
}

export function resolveAcceptanceStop(
  db: Database.Database,
  input: {
    dispatchId: string
    decision: 'accept' | 'reject'
    actor: string
    reason: string
    now: number
  }
): AcceptanceStop | null {
  const existing = getAcceptanceStop(db, input.dispatchId)
  if (existing === null || existing.state !== 'pending') {
    return existing
  }
  db.prepare(
    `UPDATE dispatch_acceptance_stops
       SET state = ?, actor = ?, reason = ?, updated_at = ?, last_seen_at = ?
     WHERE dispatch_id = ? AND state = 'pending'`
  ).run(
    input.decision === 'accept' ? 'accepted' : 'rejected',
    input.actor.trim().slice(0, 200),
    input.reason.trim().slice(0, 500),
    input.now,
    input.now,
    input.dispatchId
  )
  return getAcceptanceStop(db, input.dispatchId)
}

export type AcceptanceGateState =
  | { state: 'no_rules' }
  | { state: 'passed'; via: 'verdicts' | 'accepted' | 'overridden' }
  /** Settlement must not happen. `undeterminable` means at least one rule could not be judged. */
  | { state: 'blocked'; failedRules: string[]; notEvaluatedRules: string[]; undeterminable: boolean }

/**
 * The gate's whole decision, from stored rows only — no command runs here (§8: the check must be
 * outside the lifecycle transaction, so execution happens earlier and this only reads its result).
 *
 * A verdict only counts for the rule revision it was produced from (C7): re-declaring a rule changes
 * its digest, and an old verdict then reads as `not_evaluated` instead of silently passing.
 */
export function acceptanceGateState(db: Database.Database, dispatchId: string): AcceptanceGateState {
  const rules = listAcceptanceRules(db, dispatchId)
  if (rules.length === 0) {
    return { state: 'no_rules' }
  }
  const stop = getAcceptanceStop(db, dispatchId)
  if (stop?.state === 'accepted') {
    return { state: 'passed', via: 'accepted' }
  }
  if (stop?.state === 'overridden') {
    // Visible as its own path, not as a pass: the caller records it as `overridden`, never `accepted`.
    return { state: 'passed', via: 'overridden' }
  }
  if (stop?.state === 'rejected') {
    return {
      state: 'blocked',
      failedRules: rules.map((rule) => rule.ruleId),
      notEvaluatedRules: [],
      undeterminable: false
    }
  }
  const verdicts = new Map(listAcceptanceVerdicts(db, dispatchId).map((v) => [v.ruleId, v]))
  const failedRules: string[] = []
  const notEvaluatedRules: string[] = []
  let undeterminable = false
  for (const rule of rules) {
    const verdict = verdicts.get(rule.ruleId)
    if (!verdict || verdict.ruleDigest !== rule.digest || verdict.ruleDeclaredAt !== rule.createdAt) {
      // Missing, or answered for a different revision of the rule.
      notEvaluatedRules.push(rule.ruleId)
      continue
    }
    if (verdict.verdict === 'failed') {
      failedRules.push(rule.ruleId)
    } else if (verdict.verdict === 'undeterminable') {
      undeterminable = true
      failedRules.push(rule.ruleId)
    }
  }
  if (failedRules.length === 0 && notEvaluatedRules.length === 0) {
    return { state: 'passed', via: 'verdicts' }
  }
  return { state: 'blocked', failedRules, notEvaluatedRules, undeterminable }
}
