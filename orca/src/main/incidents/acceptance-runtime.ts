// Runtime glue for acceptance (issue-sedimentation.md v2.6 §8, M5-2/M5-3).
//
// Two entry points, both in the main process, both resolving the incidents store lazily so a host that
// never declared an acceptance pays nothing:
//   * `evaluateAcceptanceForDispatch` — async, runs the declared commands OUTSIDE any transaction and
//     stores one verdict per rule. This is the only place a command is executed.
//   * `gateDispatchSettlement` — sync, reads the stored verdicts and answers "may this dispatch settle".
//     Called by `reconcileLifecycleMessage` before `settleWorkerReport`; it never runs a command.
//
// A host with no incidents store, or a dispatch with no rules, returns `no_rules`/no-op: existing
// settlement behaviour is untouched (the M5 regression requirement).

import type Database from '../sqlite/sync-database'
import {
  acceptanceGateState,
  declareAcceptanceRule,
  listAcceptanceRules,
  type AcceptanceRule,
  type DeclareRuleInput
} from './dispatch-acceptance-store'
import { evaluateAcceptanceRules, type AcceptanceRunner } from './dispatch-acceptance-run'
import { gateDispatchSettlement, type AcceptanceGateVerdict } from './acceptance-gate'
import { incidentRuntimeStore } from './incident-writer'
import { writeAcceptanceVerdict } from './dispatch-acceptance-store'

import type { IncidentStore } from './incident-store'

type Runtime = { store: IncidentStore; db: Database.Database } | null

function runtimeOrNull(): Runtime {
  const runtime = incidentRuntimeStore()
  return runtime === null ? null : { store: runtime.store, db: runtime.db }
}

/** One dispatch id IS one attempt ("Dispatch ID is the Attempt identity"), so the epoch is a constant. */
export const ACCEPTANCE_ATTEMPT_EPOCH = 1

export function declareAcceptance(
  input: DeclareRuleInput & { runtime?: Runtime }
): { ok: true; rule: AcceptanceRule } | { ok: false; reason: 'incident_store_unavailable' } {
  const runtime = input.runtime === undefined ? runtimeOrNull() : input.runtime
  if (runtime === null) {
    return { ok: false, reason: 'incident_store_unavailable' }
  }
  const { runtime: _runtime, ...declaration } = input
  return { ok: true, rule: declareAcceptanceRule(runtime.db, declaration) }
}

/**
 * Evaluate every declared rule of one dispatch, store the verdicts, and return them.
 *
 * Never throws: a failed evaluation is itself a verdict (`undeterminable`) and the caller's settlement
 * path must not be broken by a diagnostics-adjacent feature.
 */
export async function evaluateAcceptanceForDispatch(
  dispatchId: string,
  options: { runner?: AcceptanceRunner; now?: () => number; runtime?: Runtime } = {}
): Promise<{ evaluated: number; passed: number; failed: number; undeterminable: number }> {
  const runtime = options.runtime === undefined ? runtimeOrNull() : options.runtime
  if (runtime === null) {
    return { evaluated: 0, passed: 0, failed: 0, undeterminable: 0 }
  }
  const rules = listAcceptanceRules(runtime.db, dispatchId)
  if (rules.length === 0) {
    return { evaluated: 0, passed: 0, failed: 0, undeterminable: 0 }
  }
  try {
    const verdicts = await evaluateAcceptanceRules({
      rules,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.now === undefined ? {} : { now: options.now })
    })
    for (const verdict of verdicts) {
      writeAcceptanceVerdict(runtime.db, verdict)
    }
    return {
      evaluated: verdicts.length,
      passed: verdicts.filter((verdict) => verdict.verdict === 'passed').length,
      failed: verdicts.filter((verdict) => verdict.verdict === 'failed').length,
      undeterminable: verdicts.filter((verdict) => verdict.verdict === 'undeterminable').length
    }
  } catch {
    return { evaluated: 0, passed: 0, failed: 0, undeterminable: 0 }
  }
}

/**
 * May this dispatch settle? Sync, read-only over stored rows, never executes a command.
 *
 * `no_rules` when the store or the declarations are absent — the caller settles exactly as before.
 */
export function gateSettlement(options: {
  dispatchId: string
  now?: number
  runtime?: Runtime
}): AcceptanceGateVerdict {
  const runtime = options.runtime === undefined ? runtimeOrNull() : options.runtime
  if (runtime === null) {
    return 'no_rules'
  }
  try {
    return gateDispatchSettlement(
      {
        db: runtime.db,
        store: runtime.store,
        attempt: ACCEPTANCE_ATTEMPT_EPOCH,
        ...(options.now === undefined ? {} : { now: options.now })
      },
      options.dispatchId
    )
  } catch {
    // A gate that throws must not turn into a settlement decision either way: treat it as "no rules"
    // and let the existing behaviour stand, because failing closed here would strand every dispatch.
    return 'no_rules'
  }
}

/**
 * The reconciliation-shaped answer for one worker_done, or null when settlement may proceed.
 *
 * Kept here so the lifecycle module gains two lines rather than a branch with its logging: the gate's
 * wording and its result shape belong together.
 */
export function acceptancePendingResult(input: {
  taskId: string
  dispatchId: string
  log: (message: string) => void
}): { action: 'acceptance_pending'; taskId: string; dispatchId: string } | null {
  if (gateSettlement({ dispatchId: input.dispatchId }) !== 'blocked') {
    return null
  }
  input.log(`Dispatch ${input.dispatchId} is blocked by acceptance rules; not settled`)
  return { action: 'acceptance_pending', taskId: input.taskId, dispatchId: input.dispatchId }
}

/** Read-only summary for the CLI: rules, verdicts, stop and the gate's current answer. */
export function acceptanceStatusForDispatch(
  db: Database.Database,
  dispatchId: string
): {
  rules: AcceptanceRule[]
  gate: ReturnType<typeof acceptanceGateState>
} {
  return { rules: listAcceptanceRules(db, dispatchId), gate: acceptanceGateState(db, dispatchId) }
}
