// Mining write path: the only place the miner records anything (issue-sedimentation.md v2.8 §10;
// simplify S3).
//
// It appends `incident_decisions` rows and nothing else — no dispatch, no orchestration row, no code.
// Two guards carry review lessons and must not be simplified away:
//
//   * terminal rows are never reopened, so automated tooling cannot make prunable rows reappear as
//     candidates;
//   * `requireFromStatus: 'untriaged'` is evaluated by the store inside the SAME transaction that
//     inserts the decision, so a `confirmed`/`watch` decision made after mining is never replaced —
//     even when the generic transition table would allow `confirmed -> duplicate` (M6 review C3).

import { sanitizeText } from './incident-sanitize'
import {
  MINE_EXCLUDED_STATUSES,
  MINER_ACTOR,
  type MineRuleName,
  type MinerTarget
} from './incident-mine-rules'
import type { IncidentMine, MineCandidate } from './incident-mine-build'
import type { IncidentStatus } from './incident-types'

/**
 * What a miner decision did, one row per candidate (M6-2).
 *
 * `skipped_*` is not a failure: it is the idempotency contract. An incident already in the target
 * state, or already terminal, is left alone so a repeated run cannot append a second decision.
 */
export type MineApplyOutcome =
  | 'applied'
  | 'skipped_already_target'
  | 'skipped_terminal'
  | 'skipped_invalid_transition'
  | 'skipped_not_found'
  | 'skipped_read_only'
  /** Another writer changed the status between mining and applying (M6 review C3). */
  | 'skipped_status_changed'
  /**
   * The row is no longer `untriaged`: a human (or another triage step) decided while the miner was
   * running. The miner never replaces that decision, even when the transition table would allow it.
   */
  | 'skipped_human_decided'

export type MineApplyResult = {
  incidentId: string
  fingerprint: string
  rule: MineRuleName
  fromStatus: IncidentStatus
  toStatus: MinerTarget
  outcome: MineApplyOutcome
  decisionId: string | null
}

export type MineApplySummary = {
  attempted: number
  appended: number
  skipped: number
  results: MineApplyResult[]
}

/**
 * The reason string written on every miner decision.
 *
 * It must let a human re-derive the decision: which rule fired, on how many rows, from how many
 * distinct ENTITIES, over what span. It never touches a summary, an evidence body or an output text —
 * those are already sanitized at write time and re-quoting them here would be a second copy of
 * something that may contain anything.
 */
export function mineDecisionReason(candidate: MineCandidate): string {
  const stats = candidate.stats
  return sanitizeText(
    `miner rule=${candidate.rule} fingerprint=${candidate.fingerprint.slice(0, 16)} ` +
      `count=${stats.count} stable_sources=${stats.stableSources} ` +
      `unknown_stable_source=${stats.unknownStableSource} ` +
      `first=${new Date(stats.firstSeen).toISOString()} last=${new Date(stats.lastSeen).toISOString()}`,
    500
  )
}

export type ApplyMineOptions = {
  /** Required: there is no default target (M6 review C6). */
  target: MinerTarget
  actor?: string
  /** Test seam; the CLI uses the store's own clock. */
  now?: () => number
}

export type MineStore = {
  getIncident: (id: string) => { effectiveStatus: IncidentStatus } | null
  appendDecision: (input: {
    incidentId: string
    toStatus: IncidentStatus
    actor: string
    reason: string
    createdAt?: number
    /** The in-transaction guard: only act if the current status is exactly this one. */
    requireFromStatus?: IncidentStatus
  }) => { outcome: string; decisionId?: string; fromStatus?: IncidentStatus }
  /** Mirrors `IncidentStore.readOnly`: a store opened for a newer schema refuses every write. */
  readOnly: boolean
}

/**
 * Apply the miner's suggestions — append-only, one decision per candidate, nothing else.
 *
 * The guard that matters (M6 review C3) is `requireFromStatus: 'untriaged'`, evaluated by the store
 * inside the SAME `BEGIN IMMEDIATE` transaction that inserts the decision. The pre-read below only
 * chooses the reported outcome; it cannot make a decision that arrived in between safe, so it is not
 * what protects the human's judgement.
 *
 * Not transaction-wrapped across candidates: each append is its own IMMEDIATE transaction, so a failure
 * on candidate 7 leaves the first six applied and readable rather than rolling back work a human can
 * already see. The count is returned either way.
 */
export function applyMineCandidates(
  store: MineStore,
  mine: IncidentMine,
  options: ApplyMineOptions
): MineApplySummary {
  const actor = options.actor ?? MINER_ACTOR
  const now = options.now
  const target = options.target
  const results: MineApplyResult[] = []
  let appended = 0
  for (const candidate of mine.candidates) {
    const base = {
      incidentId: candidate.incidentId,
      fingerprint: candidate.fingerprint,
      rule: candidate.rule,
      fromStatus: candidate.fromStatus,
      toStatus: target
    }
    if (store.readOnly) {
      results.push({ ...base, outcome: 'skipped_read_only', decisionId: null })
      continue
    }
    const view = store.getIncident(candidate.incidentId)
    if (view === null) {
      results.push({ ...base, outcome: 'skipped_not_found', decisionId: null })
      continue
    }
    // §11.5: terminal decisions are never reopened by automated tooling — a miner that could move a
    // `duplicate` would quietly make prunable rows reappear as candidates.
    if (MINE_EXCLUDED_STATUSES.includes(view.effectiveStatus)) {
      results.push({
        ...base,
        fromStatus: view.effectiveStatus,
        outcome: 'skipped_terminal',
        decisionId: null
      })
      continue
    }
    if (view.effectiveStatus === target) {
      results.push({
        ...base,
        fromStatus: view.effectiveStatus,
        outcome: 'skipped_already_target',
        decisionId: null
      })
      continue
    }
    // A candidate is minted from an untriaged row. Anything else means someone decided in between, and
    // the miner is not allowed to replace that — not even with the transition table's permission.
    if (view.effectiveStatus !== candidate.fromStatus) {
      results.push({
        ...base,
        fromStatus: view.effectiveStatus,
        outcome: 'skipped_human_decided',
        decisionId: null
      })
      continue
    }
    const decision = store.appendDecision({
      incidentId: candidate.incidentId,
      toStatus: target,
      actor,
      reason: mineDecisionReason(candidate),
      requireFromStatus: candidate.fromStatus,
      ...(now === undefined ? {} : { createdAt: now() })
    })
    if (decision.outcome === 'appended') {
      appended += 1
      results.push({
        ...base,
        fromStatus: decision.fromStatus ?? view.effectiveStatus,
        outcome: 'applied',
        decisionId: decision.decisionId ?? null
      })
      continue
    }
    results.push({
      ...base,
      fromStatus: decision.fromStatus ?? view.effectiveStatus,
      outcome:
        decision.outcome === 'status_unchanged'
          ? 'skipped_already_target'
          : decision.outcome === 'status_changed'
            ? MINE_EXCLUDED_STATUSES.includes(decision.fromStatus as IncidentStatus)
              ? 'skipped_terminal'
              : 'skipped_status_changed'
            : decision.outcome === 'invalid_transition'
              ? 'skipped_invalid_transition'
              : 'skipped_not_found',
      decisionId: null
    })
  }
  return {
    attempted: mine.candidates.length,
    appended,
    skipped: results.length - appended,
    results
  }
}

