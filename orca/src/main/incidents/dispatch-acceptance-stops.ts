// Acceptance stops and the gate's read-only decision (issue-sedimentation.md v2.6 §8, M5-3).
//
// Split from the declaration store so each file stays readable: this one owns the *visible stop* and the
// one question settlement asks ("may this dispatch settle?"), and it never runs a command.

import type Database from './../sqlite/sync-database'
import {
  listAcceptanceRules,
  listAcceptanceVerdicts
} from './dispatch-acceptance-store'

export type AcceptanceStopState = 'pending' | 'accepted' | 'rejected'

export type AcceptanceStop = {
  dispatchId: string
  state: AcceptanceStopState
  incidentId: string | null
  openedAt: number
  updatedAt: number
  actor: string | null
  reason: string | null
  attempts: number
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
    attempts: Number(row.attempts)
  }
}

/**
 * Open or refresh the stop. A pending stop keeps counting attempts; `accepted`/`rejected` are terminal
 * operator decisions and are not overwritten by a later automated failure.
 */
export function openAcceptanceStop(
  db: Database.Database,
  input: { dispatchId: string; incidentId: string | null; now: number }
): AcceptanceStop {
  const existing = getAcceptanceStop(db, input.dispatchId)
  if (existing?.state === 'accepted' || existing?.state === 'rejected') {
    return existing
  }
  db.prepare(
    `INSERT INTO dispatch_acceptance_stops
       (dispatch_id, state, incident_id, opened_at, updated_at, actor, reason, attempts)
     VALUES (?, 'pending', ?, ?, ?, NULL, NULL, 1)
     ON CONFLICT(dispatch_id) DO UPDATE SET
       incident_id = COALESCE(excluded.incident_id, dispatch_acceptance_stops.incident_id),
       updated_at = excluded.updated_at,
       attempts = dispatch_acceptance_stops.attempts + 1`
  ).run(input.dispatchId, input.incidentId, input.now, input.now)
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
       SET state = ?, actor = ?, reason = ?, updated_at = ?
     WHERE dispatch_id = ? AND state = 'pending'`
  ).run(
    input.decision === 'accept' ? 'accepted' : 'rejected',
    input.actor.trim().slice(0, 200),
    input.reason.trim().slice(0, 500),
    input.now,
    input.dispatchId
  )
  return getAcceptanceStop(db, input.dispatchId)
}

export type AcceptanceGateState =
  | { state: 'no_rules' }
  | { state: 'passed'; via: 'verdicts' | 'accepted' }
  /** Settlement must not happen. `undeterminable` means at least one rule could not be judged. */
  | { state: 'blocked'; failedRules: string[]; notEvaluatedRules: string[]; undeterminable: boolean }

/**
 * The gate's whole decision, from stored rows only — no command runs here (§8: the check must be
 * outside the lifecycle transaction, so execution happens earlier and this only reads its result).
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
  if (stop?.state === 'rejected') {
    return { state: 'blocked', failedRules: rules.map((rule) => rule.ruleId), notEvaluatedRules: [], undeterminable: false }
  }
  const verdicts = new Map(listAcceptanceVerdicts(db, dispatchId).map((v) => [v.ruleId, v]))
  const failedRules: string[] = []
  const notEvaluatedRules: string[] = []
  let undeterminable = false
  for (const rule of rules) {
    const verdict = verdicts.get(rule.ruleId)
    if (!verdict) {
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
