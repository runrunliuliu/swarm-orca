// Runtime glue for acceptance (issue-sedimentation.md v2.6 §8, M5-2/M5-3; M5 review C3/C4).
//
// Two entry points, both in the main process:
//   * `evaluateAcceptanceForDispatch` — async, runs the declared commands OUTSIDE any transaction and
//     stores one verdict per rule. This is the only place a command is executed.
//   * `decideWorkerReportAcceptance` / `decideMaintenanceAcceptance` — sync, read the stored verdicts
//     and answer "may this dispatch settle". Neither ever runs a command.
//
// Store resolution is the part the review rewrote. Three states are now distinct:
//   * `absent` — no incidents database file exists. Nothing was ever declared, and creating the file to
//     find that out would make "no declaration" a side effect (C4). Zero side effects, `no_rules`.
//   * `no_rules` — the file exists and is readable, but this dispatch has no declaration.
//   * `unavailable` — the file exists and cannot be read (corrupt, unreadable, newer schema opened
//     read-only and unwritable). The old code caught this and returned `no_rules`, which settled a
//     dispatch whose declaration it could not check. Fail closed (C3).

import { existsSync } from 'node:fs'
import type Database from '../sqlite/sync-database'
import {
  acceptanceGateState,
  declareAcceptanceRule,
  listAcceptanceRules,
  writeAcceptanceVerdict,
  type AcceptanceRule,
  type DeclareRuleInput
} from './dispatch-acceptance-store'
import { evaluateAcceptanceRules, type AcceptanceRunner } from './dispatch-acceptance-run'
import {
  gateDispatchSettlement,
  recordAcceptanceBypass,
  type AcceptanceGateOutcome
} from './acceptance-gate'
import { recordAcceptanceEvaluation } from './dispatch-acceptance-stops'
import { incidentRuntimeStoreIfPresent } from './incident-writer'
import { resolveMainProcessIncidentsDatabaseFile } from './incidents-paths'

import type { IncidentStore } from './incident-store'

type Runtime = { store: IncidentStore; db: Database.Database; readOnly?: boolean } | null

/**
 * What the gate found when it looked for declarations.
 *
 * `unavailable` carries a reason because the log line and `incident acceptance list` must be able to
 * name the failure instead of printing "blocked" with no cause.
 */
export type AcceptanceProbe =
  | { kind: 'absent' }
  | { kind: 'no_rules' }
  | { kind: 'rules'; runtime: NonNullable<Runtime> }
  | { kind: 'unavailable'; reason: string }

/** One dispatch id IS one attempt ("Dispatch ID is the Attempt identity"), so the epoch is a constant. */
export const ACCEPTANCE_ATTEMPT_EPOCH = 1

function runtimeFromStore(store: ReturnType<typeof incidentRuntimeStoreIfPresent>): Runtime {
  return store === null ? null : { store: store.store, db: store.db }
}

function hasAcceptanceTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('dispatch_acceptance_rules') as { present: number } | undefined
  return row !== undefined
}

function inspect(runtime: NonNullable<Runtime>, dispatchId: string): AcceptanceProbe {
  try {
    if (!hasAcceptanceTable(runtime.db)) {
      // A store written before M5: no declaration surface, so nothing was declared.
      return { kind: 'no_rules' }
    }
    const count = runtime.db
      .prepare('SELECT COUNT(*) AS n FROM dispatch_acceptance_rules WHERE dispatch_id = ?')
      .get(dispatchId) as { n: number }
    return Number(count.n) === 0 ? { kind: 'no_rules' } : { kind: 'rules', runtime }
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `acceptance_declarations_unreadable:${error instanceof Error ? error.name : 'unknown'}`
    }
  }
}

/**
 * Look for this dispatch's declarations without creating anything.
 *
 * An injected `runtime` short-circuits the filesystem probe (tests and the already-open main-process
 * store); production resolves the process store, which never creates the database (C4).
 */
export function probeAcceptanceStore(
  dispatchId: string,
  options: { runtime?: Runtime } = {}
): AcceptanceProbe {
  if (options.runtime !== undefined) {
    return options.runtime === null ? { kind: 'absent' } : inspect(options.runtime, dispatchId)
  }
  // Resolve the process store FIRST: it may already be open (startup, a crash write, a test fixture),
  // in which case a probe is one indexed read and the "does the file exist" question is moot.
  const runtime = runtimeFromStore(incidentRuntimeStoreIfPresent())
  if (runtime !== null) {
    return inspect(runtime, dispatchId)
  }
  const resolvedPath = resolveMainProcessIncidentsDatabaseFile()
  if (resolvedPath === null || !existsSync(resolvedPath)) {
    // No user-data directory, or no incidents database file yet: there is nowhere a declaration could
    // live on this host, and creating the file to prove it would be the C4 side effect.
    return { kind: 'absent' }
  }
  // The file is on disk but the process store could not be opened. That is exactly the case the
  // review called out as fail-open: we cannot know whether this dispatch has a declaration.
  return { kind: 'unavailable', reason: 'incident_store_open_failed' }
}

export function declareAcceptance(
  input: DeclareRuleInput & { runtime?: Runtime }
): { ok: true; rule: AcceptanceRule } | { ok: false; reason: 'incident_store_unavailable' } {
  const runtime =
    input.runtime === undefined ? runtimeFromStore(incidentRuntimeStoreIfPresent()) : input.runtime
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
 * path must not be broken by a diagnostics-adjacent feature. `unavailable` is reported instead of
 * silently reading as "nothing to evaluate" (C3): the caller then fails closed.
 */
export async function evaluateAcceptanceForDispatch(
  dispatchId: string,
  options: { runner?: AcceptanceRunner; now?: () => number; runtime?: Runtime } = {}
): Promise<{
  evaluated: number
  passed: number
  failed: number
  undeterminable: number
  unavailable: boolean
}> {
  const probe = probeAcceptanceStore(dispatchId, options)
  if (probe.kind === 'absent' || probe.kind === 'no_rules') {
    return { evaluated: 0, passed: 0, failed: 0, undeterminable: 0, unavailable: false }
  }
  if (probe.kind === 'unavailable') {
    return { evaluated: 0, passed: 0, failed: 0, undeterminable: 0, unavailable: true }
  }
  const runtime = probe.runtime
  const rules = listAcceptanceRules(runtime.db, dispatchId)
  if (rules.length === 0) {
    return { evaluated: 0, passed: 0, failed: 0, undeterminable: 0, unavailable: false }
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
    // C6: this is the counter that means "we ran the command", so it is only touched here.
    recordAcceptanceEvaluation(runtime.db, {
      dispatchId,
      now: (options.now ?? Date.now)(),
      error: verdicts.some((verdict) => verdict.verdict === 'undeterminable')
        ? verdicts.find((verdict) => verdict.verdict === 'undeterminable')?.detail ?? null
        : null
    })
    return {
      evaluated: verdicts.length,
      passed: verdicts.filter((verdict) => verdict.verdict === 'passed').length,
      failed: verdicts.filter((verdict) => verdict.verdict === 'failed').length,
      undeterminable: verdicts.filter((verdict) => verdict.verdict === 'undeterminable').length,
      unavailable: false
    }
  } catch {
    recordAcceptanceEvaluation(runtime.db, {
      dispatchId,
      now: (options.now ?? Date.now)(),
      error: 'evaluation_failed'
    })
    return { evaluated: 0, passed: 0, failed: 0, undeterminable: 0, unavailable: false }
  }
}

/** The gate's answer as a settlement decision; the only shape the orchestration layer imports. */
export type AcceptanceDecision =
  | { action: 'allow'; via: 'no_rules' | 'passed' | 'overridden' }
  | { action: 'blocked'; reason: 'blocked' | 'store_unavailable'; dispatchId: string }

function decideFromOutcome(dispatchId: string, outcome: AcceptanceGateOutcome): AcceptanceDecision {
  if (outcome.verdict === 'no_rules') {
    return { action: 'allow', via: 'no_rules' }
  }
  if (outcome.verdict === 'passed') {
    return { action: 'allow', via: outcome.via === 'overridden' ? 'overridden' : 'passed' }
  }
  return {
    action: 'blocked',
    reason: outcome.verdict === 'store_unavailable' ? 'store_unavailable' : 'blocked',
    dispatchId
  }
}

/** The gate outcome, for diagnostics and the maintenance override path. */
export function gateSettlement(options: {
  dispatchId: string
  now?: number
  runtime?: Runtime
}): AcceptanceGateOutcome {
  const probe = probeAcceptanceStore(options.dispatchId, options)
  if (probe.kind === 'absent' || probe.kind === 'no_rules') {
    return { verdict: 'no_rules', blockedRules: [] }
  }
  if (probe.kind === 'unavailable') {
    return { verdict: 'store_unavailable', blockedRules: [], reason: probe.reason }
  }
  try {
    return gateDispatchSettlement(
      {
        db: probe.runtime.db,
        store: probe.runtime.store,
        writable: probe.runtime.readOnly !== true,
        ...(options.now === undefined ? {} : { now: options.now })
      },
      options.dispatchId
    )
  } catch (error) {
    // A gate that throws read the declarations and failed mid-decision. Settling here would be the
    // fail-open the review blocked (C3): report the store as unavailable and leave the dispatch open.
    return {
      verdict: 'store_unavailable',
      blockedRules: [],
      reason: `acceptance_gate_failed:${error instanceof Error ? error.name : 'unknown'}`
    }
  }
}

/**
 * Every `worker_report` settlement calls this (C1). There is NO override: a worker's own report is
 * exactly the claim acceptance exists to check.
 */
export function decideWorkerReportAcceptance(dispatchId: string): AcceptanceDecision {
  return decideFromOutcome(dispatchId, gateSettlement({ dispatchId }))
}

/**
 * Operator maintenance paths (`task -> terminal`, decision gate, low-level completion) call this.
 *
 * They may bypass, but only with an explicit actor and reason, and only when the bypass itself can be
 * recorded. A store that cannot take the evidence cannot grant the bypass: that is the difference
 * between an audited override and a silent completion.
 */
export function decideMaintenanceAcceptance(input: {
  dispatchId: string
  override: { actor: string; reason: string } | null
}): AcceptanceDecision {
  const outcome = gateSettlement({ dispatchId: input.dispatchId })
  if (outcome.verdict !== 'blocked' && outcome.verdict !== 'store_unavailable') {
    return decideFromOutcome(input.dispatchId, outcome)
  }
  const override = input.override
  if (override === null || override.actor.trim().length === 0 || override.reason.trim().length === 0) {
    return {
      action: 'blocked',
      reason: outcome.verdict === 'store_unavailable' ? 'store_unavailable' : 'blocked',
      dispatchId: input.dispatchId
    }
  }
  const probe = probeAcceptanceStore(input.dispatchId)
  if (probe.kind === 'absent' || probe.kind === 'no_rules') {
    // Nothing to bypass: the declaration disappeared between the two reads.
    return decideFromOutcome(input.dispatchId, gateSettlement({ dispatchId: input.dispatchId }))
  }
  if (probe.kind === 'unavailable') {
    return { action: 'blocked', reason: 'store_unavailable', dispatchId: input.dispatchId }
  }
  const rules =
    outcome.verdict === 'blocked'
      ? outcome.blockedRules
      : listAcceptanceRules(probe.runtime.db, input.dispatchId).map((rule) => rule.ruleId)
  const recorded = recordAcceptanceBypass(
    {
      db: probe.runtime.db,
      store: probe.runtime.store,
      writable: probe.runtime.readOnly !== true
    },
    { dispatchId: input.dispatchId, actor: override.actor, reason: override.reason, rules }
  )
  return recorded
    ? { action: 'allow', via: 'overridden' }
    : { action: 'blocked', reason: 'store_unavailable', dispatchId: input.dispatchId }
}

/**
 * The one log line a blocked settlement writes.
 *
 * Kept here so the lifecycle module gains a call rather than a branch with its own wording, and so the
 * two reasons (`blocked` vs `store_unavailable`) cannot drift between the coordinator, the RPC path and
 * the CLI.
 */
export function logAcceptanceBlocked(
  dispatchId: string,
  reason: 'blocked' | 'store_unavailable',
  log: (message: string) => void
): void {
  log(
    reason === 'store_unavailable'
      ? `Dispatch ${dispatchId} is not settled: the incidents store cannot be read, so its acceptance rules cannot be checked (fail-closed)`
      : `Dispatch ${dispatchId} is blocked by acceptance rules; not settled`
  )
}

/**
 * The reconciliation-shaped answer for one worker_done, or null when settlement may proceed.
 *
 * Retained for callers that ask the question without running a settlement; the reconciliation path
 * itself reads the decision out of `settleWorkerReport` so the gate runs exactly once.
 */
export function acceptancePendingResult(input: {
  taskId: string
  dispatchId: string
  log: (message: string) => void
}): { action: 'acceptance_pending'; taskId: string; dispatchId: string } | null {
  const decision = decideWorkerReportAcceptance(input.dispatchId)
  if (decision.action === 'allow') {
    return null
  }
  logAcceptanceBlocked(input.dispatchId, decision.reason, input.log)
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
