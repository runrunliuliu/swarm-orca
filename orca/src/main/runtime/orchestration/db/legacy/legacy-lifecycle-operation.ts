import type {
  DispatchContextRow,
  LegacyCompatibilityPrincipalRow,
  MessageType,
  MessagePriority,
  MessageRow,
  WorkerReportOutcome,
  WorkerReportSettlement,
  LegacyOperationReceiptRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'
import { decideWorkerReportAcceptance, type AcceptanceDecision } from '../../../../incidents/integration'
import type { AcceptanceDecisions } from '../dispatch-context/dispatch-completion'
// Import only: the admission predicate and the sibling-decision reader are Worker B's, and the local
// send path already owns them. Reusing them keeps this path's sibling map identical to that one (and
// keeps the reporting dispatch out of it — deciding it here would be a second gate call on the same
// dispatch, which is exactly the extra `gate_seen_count` bump F7 is about).
import {
  readSiblingDispatchAcceptance,
  readWorkerReportAdmission,
  type WorkerReportAdmission
} from '../dispatch-context/worker-report-settlement'

type LegacyLifecycleOperationParams = {
  principalId: string
  operationKey: string
  method: string
  payloadHash: string
  message: {
    existingId?: string
    to: string
    subject: string
    body?: string
    type: MessageType
    priority?: MessagePriority
    payload?: string
  }
  lifecycle:
    | { kind: 'message_only' }
    | { kind: 'heartbeat'; at: string }
    | {
        kind: 'worker_report'
        taskId: string
        outcome: WorkerReportOutcome
        result: string
      }
}

/**
 * Would this legacy `worker_report` settle at all — and if so, which siblings does it settle?
 *
 * Read-only, and answered before the gate runs.
 *
 * The gate's blocked branch writes an acceptance incident and bumps a stop's seen count in a *second*
 * database. A legacy re-delivery that the transaction answers as `duplicate`, or rejects as
 * inactive/mismatched, must not fabricate that evidence — the same rule Worker B applied to the local
 * send path (F7), one path over; the local preflight does not cover this function because it calls
 * `settleWorkerReportInTransaction` directly.
 *
 * Every check here is repeated, unchanged, inside the transaction: this is a preflight, not a
 * replacement. `null` means "do not decide acceptance" — it never means "allow" — and a report that
 * becomes admissible in between is still gated exactly once. The admission also carries the sibling
 * ids, so the sibling decisions are taken for those dispatches only and never for the reporting one.
 */
function readLegacyWorkerReportAdmission(
  db: OrchestrationDb,
  params: LegacyLifecycleOperationParams,
  context: {
    taskId: string
    outcome: WorkerReportOutcome
    principal: LegacyCompatibilityPrincipalRow | undefined
    dispatch: DispatchContextRow | undefined
  }
): WorkerReportAdmission | null {
  // 1. A matching receipt means the transaction answers `duplicate`; nothing is settled.
  if (db.requireMatchingLegacyOperationReceipt(params) !== undefined) {
    return null
  }
  // 2. The principal must still be able to send lifecycle work.
  const principal = context.principal
  if (
    !principal ||
    principal.role !== 'worker' ||
    !['committed', 'settled'].includes(principal.status)
  ) {
    return null
  }
  // 3. The dispatch must be this principal's legacy attempt, and settleable — or a matching completion
  //    reconstruction through an existing message.
  const dispatch = context.dispatch
  if (
    !dispatch ||
    dispatch.run_id !== principal.run_id ||
    dispatch.contract_version !== LEGACY_CONTRACT_VERSION
  ) {
    return null
  }
  if (
    (principal.status === 'settled' || !['pending', 'dispatched'].includes(dispatch.status)) &&
    !params.message.existingId
  ) {
    return null
  }
  // 4. An existing message must be this principal's, on one of its own routes.
  if (params.message.existingId !== undefined) {
    const existing = db.getMessageById(params.message.existingId)
    const delivery = db.resolveLegacyWorkerCoordinatorDelivery(principal.run_id, params.message.to)
    const matchesOriginalLegacyRoute =
      existing?.delivery_contract === 'legacy_direct' && existing.to_handle === params.message.to
    const matchesCurrentRoute =
      existing?.delivery_contract === delivery.contract && existing.to_handle === delivery.to
    if (
      !existing ||
      existing.run_id !== principal.run_id ||
      existing.from_handle !== principal.terminal_handle ||
      (!matchesOriginalLegacyRoute && !matchesCurrentRoute)
    ) {
      return null
    }
  }
  // 5. The settlement's own admission predicate: a duplicate, stale, mismatched or inactive report gets
  //    its ordinary answer from the transaction, and no gate.
  return readWorkerReportAdmission(db, {
    taskId: context.taskId,
    dispatchId: dispatch.id,
    outcome: context.outcome
  })
}

/**
 * Name the siblings a legacy settlement left open because they became active after the preflight.
 *
 * The in-transaction helper reports an unsettled sibling through its own `log` option, and this caller
 * cannot pass one: `WorkerReportSettlementParams & AcceptanceGateInput` (Worker B's file) carries no
 * log field, so adding it here would be the same excess-property mistake this task fixes. The same
 * fact is therefore emitted here for the dispatches only this caller can identify — active after the
 * settlement, not the reporting dispatch, and absent from the map that was handed in — using the
 * helper's own wording so the two cannot drift.
 */
function warnAboutUnsettledLegacySiblings(
  db: OrchestrationDb,
  taskId: string,
  reportingDispatchId: string,
  decisions: AcceptanceDecisions
): void {
  const rows = db.db
    .prepare(
      `SELECT id FROM dispatch_contexts
       WHERE task_id = ? AND id <> ? AND status IN ('pending', 'dispatched')`
    )
    .all(taskId, reportingDispatchId) as { id: string }[]
  for (const row of rows) {
    if (decisions.has(row.id)) {
      continue
    }
    console.warn(
      '[orchestration]',
      `Dispatch ${row.id} left unsettled: it has no precomputed acceptance decision (it became active after the decision was computed); re-run the transition to decide and settle it`
    )
  }
}

export function commitLegacyLifecycleOperation(
  this: OrchestrationDb,
  params: LegacyLifecycleOperationParams
): {
  receipt: LegacyOperationReceiptRow
  message: MessageRow
  settlement?: WorkerReportSettlement
  duplicate: boolean
} {
  // §8 C1: gate decision before the transaction, exactly like the local send path. A legacy
  // worker_report that the gate blocks keeps its principal `committed` (so the client may retry after
  // a resolve) and leaves the message unread for the coordinator to re-reconcile.
  //
  // A read outside the transaction, so the gate itself stays outside it. The principal row is
  // validated again inside; this copy only supplies the dispatch id the gate needs.
  const reportedTaskId = params.lifecycle.kind === 'worker_report' ? params.lifecycle.taskId : null
  const legacyPrincipal =
    reportedTaskId === null ? undefined : this.getLegacyCompatibilityPrincipal(params.principalId)
  const ownDispatchId = legacyPrincipal?.dispatch_id ?? null
  const ownDispatch =
    ownDispatchId === null ? undefined : this.getDispatchContextById(ownDispatchId)
  // F7, one path over: a report the transaction will answer as `duplicate` or reject as
  // inactive/mismatched must not reach the gate, whose blocked branch writes a second database's rows.
  // `null` here means "no decision" — it is never passed on as an allow.
  const admission =
    reportedTaskId !== null && params.lifecycle.kind === 'worker_report'
      ? readLegacyWorkerReportAdmission(this, params, {
          taskId: reportedTaskId,
          outcome: params.lifecycle.outcome,
          principal: legacyPrincipal,
          dispatch: ownDispatch
        })
      : null
  const willSettle = admission?.verdict === 'admitted'
  const acceptance: AcceptanceDecision | null | undefined =
    reportedTaskId === null || params.lifecycle.kind !== 'worker_report'
      ? undefined
      : !willSettle
        ? null
        : ownDispatchId === null
          ? { action: 'allow', via: 'no_rules' }
          : decideWorkerReportAcceptance(ownDispatchId)
  // F1: the sibling dispatches this report also settles are decided here too, before `BEGIN IMMEDIATE`.
  // The settlement's in-transaction body only applies this map, so a sibling it does not cover is left
  // unsettled instead of being decided while this connection holds the lifecycle writer.
  const siblingDecisions: AcceptanceDecisions =
    admission?.verdict === 'admitted' && params.lifecycle.kind === 'worker_report'
      ? // The list is the admission's own: it excludes the reporting dispatch, whose answer is
        // `acceptance` above. Deciding it a second time here would bump its stop's seen count for a
        // decision already taken — measured, not assumed (FC2): precomputing the whole task and then
        // dropping the reporting dispatch still calls the gate for it first. A failing report
        // force-fails its siblings, so `readSiblingDispatchAcceptance` returns an empty map there.
        readSiblingDispatchAcceptance(admission.siblingDispatchIds, params.lifecycle.outcome)
      : new Map()
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const principal = this.getLegacyCompatibilityPrincipal(params.principalId)
    if (
      !principal ||
      principal.role !== 'worker' ||
      !['committed', 'settled'].includes(principal.status)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy compatibility principal ${params.principalId} cannot send lifecycle work.`
      )
    }
    const dispatchId = principal.dispatch_id as string
    const existingReceipt = this.requireMatchingLegacyOperationReceipt(params)
    if (existingReceipt) {
      const response = JSON.parse(existingReceipt.response_json) as {
        messageId: string
        settlement?: WorkerReportSettlement
      }
      const message = this.getMessageById(response.messageId)
      if (!message) {
        throw new OrchestrationError(
          'operation_unknown',
          `Legacy operation ${params.operationKey} lost its recorded message.`
        )
      }
      this.db.exec('COMMIT')
      return {
        receipt: existingReceipt,
        message,
        settlement: response.settlement,
        duplicate: true
      }
    }

    const dispatch = this.getDispatchContextById(dispatchId)
    if (
      !dispatch ||
      dispatch.run_id !== principal.run_id ||
      dispatch.contract_version !== LEGACY_CONTRACT_VERSION
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is not this principal's legacy attempt.`
      )
    }
    if (
      (principal.status === 'settled' || !['pending', 'dispatched'].includes(dispatch.status)) &&
      (!params.message.existingId || params.lifecycle.kind !== 'worker_report')
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is settled and only matching completion reconstruction is allowed.`
      )
    }
    let message = params.message.existingId
      ? this.getMessageById(params.message.existingId)
      : undefined
    const delivery = this.resolveLegacyWorkerCoordinatorDelivery(
      principal.run_id,
      params.message.to
    )
    if (params.message.existingId) {
      const matchesOriginalLegacyRoute =
        message?.delivery_contract === 'legacy_direct' && message.to_handle === params.message.to
      const matchesCurrentRoute =
        message?.delivery_contract === delivery.contract && message.to_handle === delivery.to
      if (
        !message ||
        message.run_id !== principal.run_id ||
        message.from_handle !== principal.terminal_handle ||
        (!matchesOriginalLegacyRoute && !matchesCurrentRoute)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Existing legacy message ${params.message.existingId} does not match this principal.`
        )
      }
    } else {
      message = this.insertMessage({
        from: principal.terminal_handle,
        to: delivery.to,
        subject: params.message.subject,
        body: params.message.body,
        type: params.message.type,
        priority: params.message.priority,
        payload: params.message.payload,
        senderPaneKey: principal.pane_key,
        runId: principal.run_id,
        deliveryContract: delivery.contract
      })
    }

    let settlement: WorkerReportSettlement | undefined
    if (params.lifecycle.kind === 'heartbeat') {
      this.recordHeartbeat(dispatchId, params.lifecycle.at)
    } else if (params.lifecycle.kind === 'worker_report') {
      const persistedOutcome =
        params.message.existingId &&
        dispatch.task_id === params.lifecycle.taskId &&
        dispatch.status === 'completed'
          ? 'succeeded'
          : params.message.existingId &&
              dispatch.task_id === params.lifecycle.taskId &&
              dispatch.status === 'failed'
            ? 'failed'
            : undefined
      settlement = persistedOutcome
        ? { action: 'settled', outcome: persistedOutcome, duplicate: true }
        : this.settleWorkerReportInTransaction({
            taskId: params.lifecycle.taskId,
            dispatchId,
            outcome: params.lifecycle.outcome,
            result: params.lifecycle.result,
            acceptance: acceptance ?? null,
            // Why this exact property name: `AcceptanceGateInput` (Worker B's file) declares
            // `siblingDecisions`. Passing a same-valued local under another name type-checks nowhere
            // and, because esbuild strips types, silently left every legacy sibling unsettled.
            siblingDecisions
          })
      if (settlement.action === 'rejected') {
        throw new OrchestrationError(settlement.code, settlement.reason)
      }
      if (settlement.action === 'acceptance_pending') {
        // Not settled and not failed: the receipt records the pending answer verbatim, and the
        // principal stays committed so the legacy client's retry remains valid.
        const pendingResponseJson = JSON.stringify({ messageId: message.id, settlement })
        const pendingReceipt = this.insertLegacyOperationReceipt({
          principalId: principal.id,
          operationKey: params.operationKey,
          method: params.method,
          payloadHash: params.payloadHash,
          effectId: message.id,
          responseJson: pendingResponseJson
        })
        this.db.exec('COMMIT')
        return { receipt: pendingReceipt, message, settlement, duplicate: false }
      }
      // A sibling that appeared after the preflight has no decision, so the settlement just left it
      // open. Name it: see warnAboutUnsettledLegacySiblings for why the wording lives in this file.
      warnAboutUnsettledLegacySiblings(this, params.lifecycle.taskId, dispatchId, siblingDecisions)
      this.db
        .prepare(
          `UPDATE legacy_compatibility_principals
           SET status = 'settled' WHERE id = ? AND status = 'committed'`
        )
        .run(principal.id)
    }
    const responseJson = JSON.stringify({ messageId: message.id, settlement })
    const receipt = this.insertLegacyOperationReceipt({
      principalId: principal.id,
      operationKey: params.operationKey,
      method: params.method,
      payloadHash: params.payloadHash,
      effectId: message.id,
      responseJson
    })
    this.db.exec('COMMIT')
    return { receipt, message, settlement, duplicate: false }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type LegacyLifecycleOperationMethods = {
  commitLegacyLifecycleOperation: typeof commitLegacyLifecycleOperation
}

export function attachLegacyLifecycleOperation(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    commitLegacyLifecycleOperation
  })
}
