import type {
  DispatchContextRow,
  WorkerDispatchRow,
  WorkerReportOutcome,
  WorkerReportSettlement
} from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { AGENT_PROMPT_STALLED_ERROR } from '../../../agent-prompt-submission-verification'
import {
  decideMaintenanceAcceptance,
  decideWorkerReportAcceptance,
  type AcceptanceDecision
} from '../../../../incidents/integration'
import {
  settleActiveDispatchesForTask,
  type AcceptanceDecisions
} from './dispatch-completion'
import { getActiveDispatchForTask } from './task-dispatch-reconciliation'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import {
  isWorkerStateIn,
  SETTLEABLE_WORKER_STATES,
  UNPROVEN_WORKER_STATES
} from '../../worker-report-admission'

type WorkerReportObservation = {
  id: string
  authorityId: string
  homeReceivedAt: number
}

type WorkerReportSettlementParams = {
  taskId: string
  dispatchId: string
  outcome: WorkerReportOutcome
  result: string
  observation?: WorkerReportObservation
}

/**
 * The acceptance decision is a REQUIRED parameter of the in-transaction settlement (M5 review C1).
 *
 * Making it required is the mechanical part of "the gate point is unique": federation import and the
 * legacy lifecycle operation used to call `settleWorkerReportInTransaction` directly, so "every path
 * funnels through the gate" was a comment rather than a constraint. Now a caller that forgets it does
 * not compile, and every call site computes the decision BEFORE it opens its write transaction.
 *
 * `siblingDecisions` is required for the same reason (review nit): it used to be optional with an
 * empty-map fallback, so an omitted map silently settled the reporting Dispatch while deciding no
 * sibling. Now the pair is one value at every call site: a caller that cannot settle (the `null`
 * preflight-rejected case below, F7) passes an explicit empty map instead of relying on a fallback.
 *
 * `null` is the second, equally explicit case (F7): the caller's admission preflight already answered
 * this report (duplicate / stale / inactive), so there is no settlement for the gate to decide and the
 * transaction must not decide one for itself. If the state moved between the two evaluations and the
 * report is admissible after all, the transaction fails closed instead of settling undecided.
 */
type AcceptanceGateInput = {
  acceptance: AcceptanceDecision | null
  /**
   * The maintenance acceptance answers for the sibling Dispatches this settlement also settles, read
   * before the transaction for the same reason (F1): `settleActiveDispatchesForTask` may not call the
   * gate inside the lifecycle write transaction, so it can only apply what it was handed. A sibling
   * with no entry here stays unsettled — never allowed — so the map is required even when it is empty.
   */
  siblingDecisions: AcceptanceDecisions
}

const WORKER_REPORT_TRANSACTION_SAVEPOINT = 'worker_report_transaction'

function recordAcceptedReportFact(db: OrchestrationDb, params: WorkerReportSettlementParams): void {
  if (!params.observation) {
    return
  }
  const existing = db
    .getAttemptObservationFacts(params.dispatchId)
    .find((fact) => fact.id === params.observation?.id)
  const sequence =
    existing?.sequence ??
    ((
      db.db
        .prepare(
          'SELECT MAX(sequence) AS sequence FROM attempt_observation_facts WHERE dispatch_id = ?'
        )
        .get(params.dispatchId) as { sequence: number | null }
    ).sequence ?? -1) + 1
  db.recordAttemptObservation({
    id: params.observation.id,
    dispatchId: params.dispatchId,
    sequence,
    authorityId: params.observation.authorityId,
    authorityClock: 'home',
    facet: 'worker_report',
    payload: { status: 'accepted', outcome: params.outcome, reportId: params.observation.id },
    sourceObservedAt: null,
    executionReceivedAt: null,
    homeReceivedAt: params.observation.homeReceivedAt
  })
}

/**
 * The maintenance acceptance answers for the sibling Dispatches a settlement will also settle.
 *
 * Same reason as the reporting worker's own decision, one dispatch over: `decideMaintenanceAcceptance`
 * writes incidents and an acceptance stop into a second database, so it is read here — outside the
 * lifecycle write transaction — and the transaction only applies the map (F1).
 *
 * The reporting dispatch is deliberately absent. Its answer is the worker gate above; asking the
 * *maintenance* gate about it too would write evidence for a path it is not on, which is the F7 defect
 * one dispatch over.
 */
export function readSiblingDispatchAcceptance(
  siblingDispatchIds: readonly string[],
  outcome: WorkerReportOutcome
): AcceptanceDecisions {
  const decisions = new Map<string, AcceptanceDecision>()
  // A failing report force-fails its siblings: a stop is not a claim of completion, so that path reads
  // no acceptance answer at all (the same rule the task status transition uses).
  if (outcome !== 'succeeded') {
    return decisions
  }
  for (const dispatchId of siblingDispatchIds) {
    decisions.set(dispatchId, decideMaintenanceAcceptance({ dispatchId, override: null }))
  }
  return decisions
}

/**
 * What the settlement would answer for a report, read-only.
 *
 * This is the settlement's own admission predicate — the same reads, the same codes and the same
 * reason strings the in-transaction path uses, in one function — factored out so a caller can ask
 * "would this settle?" BEFORE it evaluates the acceptance gate. The gate's blocked branch writes an
 * incident and bumps a stop's seen count (a second database), so evaluating it for a report that the
 * settlement then rejects leaves acceptance evidence for a settlement that never happens (F7).
 *
 * It writes nothing. `already_settled` is not a rejection: the report is the duplicate of a settlement
 * that did happen, and the caller must still answer with the ordinary `settled, duplicate: true`.
 */
export type WorkerReportAdmission =
  | {
      verdict: 'admitted'
      dispatch: DispatchContextRow
      expectedDispatchStatus: 'completed' | 'failed'
      expectedTaskStatus: 'completed' | 'failed'
      reportingWorker: WorkerDispatchRow | undefined
      settledByUnobservedPrompt: boolean
      unprovenWorker: boolean
      reconnectingWorker: boolean
      reportingStart: boolean
      siblingDispatchIds: string[]
    }
  | { verdict: 'already_settled'; result: Extract<WorkerReportSettlement, { action: 'settled' }> }
  | { verdict: 'rejected'; result: Extract<WorkerReportSettlement, { action: 'rejected' }> }

export function readWorkerReportAdmission(
  db: OrchestrationDb,
  params: { taskId: string; dispatchId: string; outcome: WorkerReportOutcome }
): WorkerReportAdmission {
  const task = db.getTask(params.taskId)
  if (!task) {
    return {
      verdict: 'rejected',
      result: { action: 'rejected', code: 'unknown_task', reason: `Unknown task ${params.taskId}.` }
    }
  }
  const dispatch = db.getDispatchContextById(params.dispatchId)
  if (!dispatch) {
    return {
      verdict: 'rejected',
      result: {
        action: 'rejected',
        code: 'unknown_dispatch',
        reason: `Unknown dispatch ${params.dispatchId}.`
      }
    }
  }
  if (dispatch.task_id !== params.taskId) {
    return {
      verdict: 'rejected',
      result: {
        action: 'rejected',
        code: 'task_dispatch_mismatch',
        reason: `Dispatch ${params.dispatchId} belongs to task ${dispatch.task_id}, not ${params.taskId}.`
      }
    }
  }

  const expectedDispatchStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
  const expectedTaskStatus = params.outcome === 'succeeded' ? 'completed' : 'failed'
  // Why (#16095): worker-start records a stalled prompt as failed, but the preamble was written
  // before verification ran — the worker may have been executing it the whole time. Its own report
  // is first-hand evidence and must be able to correct that record instead of being thrown away.
  // Checked before the duplicate short-circuit: a `failed` report lands on the very statuses that
  // short-circuit reads as already settled, dropping the worker's real cause and result body.
  const settledByUnobservedPrompt =
    dispatch.status === 'failed' &&
    dispatch.last_failure === AGENT_PROMPT_STALLED_ERROR &&
    task.status === 'failed'
  const reportingWorker = db.getWorkerDispatch(params.dispatchId)
  if (
    !settledByUnobservedPrompt &&
    dispatch.status === expectedDispatchStatus &&
    task.status === expectedTaskStatus
  ) {
    return {
      verdict: 'already_settled',
      result: { action: 'settled', outcome: params.outcome, duplicate: true }
    }
  }
  const unprovenWorker = isWorkerStateIn(UNPROVEN_WORKER_STATES, reportingWorker?.state)
  const reconnectingWorker =
    (dispatch.status === 'pending' || dispatch.status === 'dispatched') &&
    task.status === 'blocked' &&
    unprovenWorker
  const reportingStart =
    dispatch.status === 'pending' &&
    task.status === 'dispatched' &&
    reportingWorker?.state === 'starting'
  const previousDispatchStatus = settledByUnobservedPrompt
    ? 'failed'
    : reconnectingWorker || reportingStart
      ? dispatch.status
      : 'dispatched'
  const previousTaskStatus = settledByUnobservedPrompt
    ? 'failed'
    : reconnectingWorker
      ? 'blocked'
      : 'dispatched'
  if (dispatch.status !== previousDispatchStatus || task.status !== previousTaskStatus) {
    return {
      verdict: 'rejected',
      result: {
        action: 'rejected',
        code: 'inactive_dispatch',
        reason: `inactive dispatch ${params.dispatchId}: it or task ${params.taskId} is already settled.`
      }
    }
  }
  const conflictingWorker = db.db
    .prepare(
      `SELECT active.id
       FROM dispatch_contexts active
       JOIN worker_dispatches worker ON worker.dispatch_id = active.id
       WHERE active.task_id = ? AND active.id != ?
         AND active.status IN ('pending', 'dispatched')
         AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
       ORDER BY active.rowid DESC LIMIT 1`
    )
    .get(params.taskId, params.dispatchId) as { id: string } | undefined
  if (conflictingWorker) {
    return {
      verdict: 'rejected',
      result: {
        action: 'rejected',
        code: 'inactive_dispatch',
        reason: `Task ${params.taskId} still has active supervised Dispatch ${conflictingWorker.id}; stop or settle it before completing ${params.dispatchId}.`
      }
    }
  }
  const latest = getActiveDispatchForTask(db, params.taskId)
  if (!reportingWorker && latest?.id !== params.dispatchId) {
    return {
      verdict: 'rejected',
      result: {
        action: 'rejected',
        code: 'stale_dispatch',
        reason: `Dispatch ${params.dispatchId} is not the current dispatch for task ${params.taskId}.`
      }
    }
  }
  const siblingDispatchIds = (
    db.db
      .prepare(
        `SELECT id FROM dispatch_contexts
       WHERE task_id = ? AND id != ? AND status IN ('pending', 'dispatched')`
      )
      .all(params.taskId, params.dispatchId) as { id: string }[]
  ).map((row) => row.id)
  return {
    verdict: 'admitted',
    dispatch,
    expectedDispatchStatus,
    expectedTaskStatus,
    reportingWorker,
    settledByUnobservedPrompt,
    unprovenWorker,
    reconnectingWorker,
    reportingStart,
    siblingDispatchIds
  }
}

export function settleWorkerReport(
  this: OrchestrationDb,
  params: WorkerReportSettlementParams
): WorkerReportSettlement {
  // F7: admission first, gate second. A duplicate, stale or otherwise inadmissible report is answered
  // by the settlement's own rejection and never reaches `decideWorkerReportAcceptance`, whose blocked
  // branch writes an acceptance incident and bumps the stop's seen count — evidence for a settlement
  // that never happens. The answer is the ordinary one; only the side effect is gone.
  const admission = readWorkerReportAdmission(this, params)
  if (admission.verdict === 'rejected') {
    return admission.result
  }
  // Outside the transaction on purpose: the gate may write an incident/stop row (a different database)
  // and must never extend the lifecycle write transaction. The commands ran earlier still — see
  // evaluateAcceptanceForDispatch in the send path.
  const acceptance =
    admission.verdict === 'admitted' ? decideWorkerReportAcceptance(params.dispatchId) : null
  // Nothing is computed for a report that cannot settle: the transaction below never reaches the write
  // half, so an empty map cannot settle anything by omission.
  const siblingDecisions =
    admission.verdict === 'admitted'
      ? readSiblingDispatchAcceptance(admission.siblingDispatchIds, params.outcome)
      : new Map<string, AcceptanceDecision>()
  return runLifecycleWriteTransaction(this.db, WORKER_REPORT_TRANSACTION_SAVEPOINT, () =>
    this.settleWorkerReportInTransaction({ ...params, acceptance, siblingDecisions })
  )
}

export function settleWorkerReportInTransaction(
  this: OrchestrationDb,
  params: WorkerReportSettlementParams & AcceptanceGateInput
): WorkerReportSettlement {
  // Admission is re-read here, with the caller's own predicate, before anything is written: the answer
  // is the one the preflight gave, or a rejection if the state moved. A report that became admissible
  // between the two reads is NOT decided inside this transaction (`acceptance: null` fails closed
  // below), because deciding here would be a second gate point inside the lifecycle write transaction.
  //
  // Residual TOCTOU, stated where it can happen: the preflight admitted the report, the gate wrote a
  // stop + incident (a second database that cannot roll back with this one), and the dispatch then
  // settled or became inactive before this re-check. The stop is then an orphan. It is idempotent —
  // keyed by dispatch + attempt + rule, and the stop row is an upsert — so a retry cannot duplicate
  // it, and it stays visible for a person to resolve. That is the accepted cost of never holding the
  // orchestration writer while another database is written.
  const admission = readWorkerReportAdmission(this, params)
  if (admission.verdict === 'already_settled') {
    recordAcceptedReportFact(this, params)
    return admission.result
  }
  if (admission.verdict === 'rejected') {
    return admission.result
  }
  const {
    dispatch,
    expectedDispatchStatus,
    expectedTaskStatus,
    reportingWorker,
    settledByUnobservedPrompt,
    unprovenWorker,
    reconnectingWorker,
    reportingStart,
    siblingDispatchIds
  } = admission
  if (params.acceptance === null) {
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Dispatch ${params.dispatchId} changed between its acceptance preflight and its settlement; not settled.`
    }
  }
  // The gate, after every rejection above and before the first write (§8 C1). A duplicate or a stale
  // report kept its own answer: the gate only decides a settlement that would otherwise happen.
  if (params.acceptance.action === 'blocked') {
    return {
      action: 'acceptance_pending',
      taskId: params.taskId,
      dispatchId: params.dispatchId,
      reason: params.acceptance.reason
    }
  }
  // The writes, entered only by an admissible report with an allow decision.
  this.db.exec('SAVEPOINT settle_worker_report')
  let dispatchUpdate: { changes: number }
  let taskUpdate: { changes: number }
  if (settledByUnobservedPrompt) {
    const now = new Date().toISOString()
    const dispatchTransition = transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: params.dispatchId,
      from: 'failed',
      to: expectedDispatchStatus,
      projection: {
        completed_at: now,
        last_failure: params.outcome === 'failed' ? params.result : dispatch.last_failure,
        capability_revoked_at: dispatch.capability_revoked_at ?? now
      },
      correction: 'unobserved_prompt_report'
    })
    const taskTransition = transitionLifecycleWithDb(this.db, {
      entity: 'task',
      id: params.taskId,
      from: 'failed',
      to: expectedTaskStatus,
      projection: { result: params.result, completed_at: now },
      correction: 'unobserved_prompt_report'
    })
    dispatchUpdate = { changes: dispatchTransition.changed ? 1 : 0 }
    taskUpdate = { changes: taskTransition.changed ? 1 : 0 }
  } else {
    if (reconnectingWorker) {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id: params.taskId,
        from: 'blocked',
        to: 'dispatched'
      })
    }
    const dispatchTransition = transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: params.dispatchId,
      from: reconnectingWorker || reportingStart ? ['pending', 'dispatched'] : 'dispatched',
      to: expectedDispatchStatus,
      projection: {
        completed_at: new Date().toISOString(),
        last_failure: params.outcome === 'failed' ? params.result : dispatch.last_failure,
        capability_revoked_at: dispatch.capability_revoked_at ?? new Date().toISOString()
      }
    })
    const taskTransition = transitionLifecycleWithDb(this.db, {
      entity: 'task',
      id: params.taskId,
      from: 'dispatched',
      to: expectedTaskStatus,
      projection: { result: params.result, completed_at: new Date().toISOString() }
    })
    dispatchUpdate = { changes: dispatchTransition.changed ? 1 : 0 }
    taskUpdate = { changes: taskTransition.changed ? 1 : 0 }
  }
  if (dispatchUpdate.changes !== 1 || taskUpdate.changes !== 1) {
    this.db.exec('ROLLBACK TO settle_worker_report')
    this.db.exec('RELEASE settle_worker_report')
    return {
      action: 'rejected',
      code: 'inactive_dispatch',
      reason: `Dispatch ${params.dispatchId} changed while its worker report was settling.`
    }
  }
  if (settledByUnobservedPrompt) {
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: params.dispatchId,
      from: 'failed',
      to: params.outcome === 'succeeded' ? 'succeeded' : 'failed',
      projection: { stage: 'settled', updated_at: new Date().toISOString() },
      correction: 'unobserved_prompt_report'
    })
  } else if ((unprovenWorker || reportingStart) && params.outcome === 'succeeded') {
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: params.dispatchId,
      from: reportingStart ? 'starting' : UNPROVEN_WORKER_STATES,
      to: 'ready',
      projection: { last_error: null }
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: params.dispatchId,
      from: 'ready',
      to: 'succeeded',
      projection: { stage: 'settled', updated_at: new Date().toISOString() }
    })
  } else if (reportingWorker) {
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: params.dispatchId,
      // An unknown worker's success report reconnects through 'ready' above; only failure settles here.
      from: params.outcome === 'succeeded' ? 'ready' : [...SETTLEABLE_WORKER_STATES, 'starting'],
      to: params.outcome === 'succeeded' ? 'succeeded' : 'failed',
      projection: { stage: 'settled', updated_at: new Date().toISOString() }
    })
  }
  settleActiveDispatchesForTask(
    this,
    params.taskId,
    expectedDispatchStatus,
    params.outcome === 'failed' ? params.result : undefined,
    // Required by `AcceptanceGateInput`: there is no empty-map fallback to hide an omitted map, so
    // the sibling answers this settlement applies are always the ones the caller computed.
    { decisions: params.siblingDecisions }
  )
  this.closeQuestionsForDispatch(params.dispatchId)
  for (const siblingDispatchId of siblingDispatchIds) {
    this.closeQuestionsForDispatch(siblingDispatchId)
  }
  if (params.outcome === 'succeeded') {
    this.promoteReadyTasks(params.taskId)
  }
  recordAcceptedReportFact(this, params)
  this.db.exec('RELEASE settle_worker_report')
  return { action: 'settled', outcome: params.outcome, duplicate: false }
}

export type WorkerReportSettlementMethods = {
  settleWorkerReport: typeof settleWorkerReport
  settleWorkerReportInTransaction: typeof settleWorkerReportInTransaction
}

export function attachWorkerReportSettlement(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    settleWorkerReport,
    settleWorkerReportInTransaction
  })
}
