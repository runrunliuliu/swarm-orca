import { OrchestrationError } from '../../orchestration-error'
import type { TaskRow, TaskStatus } from '../../types'
import {
  precomputeActiveDispatchAcceptance,
  settleActiveDispatchesForTask,
  type AcceptanceDecisions,
  type AcceptanceOverride,
  type DispatchSettlementReport
} from '../dispatch-context/dispatch-completion'
import type { OrchestrationDb } from '../orchestration-db'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'

const UPDATE_TASK_STATUS_SAVEPOINT = 'update_task_status'

/**
 * A Task transition's row plus the settlement answer that produced it.
 *
 * Same shape as the `TaskRow | undefined` every direct caller already uses, plus `skipped` — the exact
 * dispatches this transition's settlement left unsettled, captured from the helper instead of being
 * re-derived by a second query (see `DispatchSettlementReport`). `skipped` is empty for a non-terminal
 * status: those transitions settle nothing, so nothing is "left unsettled" by them.
 */
export type TaskStatusTransitionOutcome = {
  task: TaskRow | undefined
  skipped: string[]
}

function applyTaskStatusTransition(
  this: OrchestrationDb,
  id: string,
  status: TaskStatus,
  result?: string,
  /** §8 C1: operator maintenance bypass; undefined means "blocked dispatches stay open". */
  acceptanceOverride?: AcceptanceOverride
): TaskStatusTransitionOutcome {
  const terminalStatus = status === 'completed' || status === 'failed'
  const requiresActiveDispatch = status === 'dispatched'
  const permitsActiveDispatch = terminalStatus || requiresActiveDispatch
  // Why before the transaction (not in the settle call below): accepting a maintenance settlement asks
  // the acceptance gate, which writes incidents and an acceptance stop into a *second* database and
  // reads it with a `busy_timeout`. The gate's own contract is that none of that happens inside the
  // orchestration WAL writer's transaction (`incidents/acceptance-gate.ts:10-17`). The map is a value,
  // so the transaction can only apply it — a dispatch it has no entry for is left unsettled, and a
  // dispatch that becomes active afterwards stays unsettled instead of being decided in here.
  // The `failed` path reads no decision at all (a stop is not a claim of completion), so it passes an
  // empty map and keeps settling exactly as before.
  const dispatchAcceptance: AcceptanceDecisions =
    status === 'completed'
      ? precomputeActiveDispatchAcceptance(this, id, {
          ...(acceptanceOverride === undefined ? {} : { acceptanceOverride })
        })
      : new Map()
  // Why: reserve the WAL writer before lifecycle reads so a concurrent commit cannot stale the snapshot.
  const transaction = beginLifecycleWriteTransaction(this.db, UPDATE_TASK_STATUS_SAVEPOINT)
  try {
    const task = this.getTask(id)
    if (!task) {
      commitLifecycleWriteTransaction(this.db, transaction)
      return { task: undefined, skipped: [] }
    }
    const active = this.db
      .prepare(
        `SELECT id FROM dispatch_contexts
         WHERE task_id = ? AND status IN ('pending', 'dispatched')
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(id) as { id: string } | undefined
    // Why: a supervised worker owns its Task for as long as it is alive. Every status this
    // function lets past the active-Dispatch check must clear the same worker check, or the Task
    // re-opens under a worker whose own lifecycle can no longer settle it (#16904 relay wedge).
    // A no-op re-assert of `dispatched` re-opens nothing and stays legal.
    const reopensUnderWorker = requiresActiveDispatch && task.status !== 'dispatched'
    const activeWorker =
      terminalStatus || reopensUnderWorker
        ? (this.db
            .prepare(
              `SELECT active.id
             FROM dispatch_contexts active
             JOIN worker_dispatches worker ON worker.dispatch_id = active.id
             WHERE active.task_id = ? AND active.status IN ('pending', 'dispatched')
               AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
             ORDER BY active.rowid DESC LIMIT 1`
            )
            .get(id) as { id: string } | undefined)
        : undefined
    if (activeWorker) {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${id} cannot move to ${status} while supervised Dispatch ${activeWorker.id} is active; stop or settle its worker first.`,
        { taskId: id, dispatchId: activeWorker.id }
      )
    }
    if (requiresActiveDispatch && !active) {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${id} cannot move to dispatched without an active Dispatch.`,
        { taskId: id }
      )
    }
    if (active && !permitsActiveDispatch) {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${id} cannot move to ${status} while Dispatch ${active.id} is active.`,
        { taskId: id, dispatchId: active.id }
      )
    }
    if (task.status === status && result === undefined) {
      commitLifecycleWriteTransaction(this.db, transaction)
      return { task, skipped: [] }
    }
    try {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id,
        from: task.status,
        to: status,
        projection: {
          result: result ?? task.result,
          completed_at: terminalStatus ? new Date().toISOString() : task.completed_at
        }
      })
    } catch (error) {
      if (!(error instanceof OrchestrationError) || error.code !== 'lifecycle_conflict') {
        throw error
      }
      const current = this.getTask(id)
      // A concurrent writer may have already applied the requested status;
      // preserve idempotency for that race, but never hide an invalid edge.
      if (!current || current.status !== status) {
        throw error
      }
      commitLifecycleWriteTransaction(this.db, transaction)
      return { task: current, skipped: [] }
    }
    let settlement: DispatchSettlementReport = { skipped: [] }
    if (terminalStatus) {
      settlement = settleActiveDispatchesForTask(this, id, status, result, {
        decisions: dispatchAcceptance,
        // F10: the option stays, so a caller can route the "left unsettled" reason. There is no logger
        // on this connection, so it goes to the main-process log rather than being discarded.
        log: (message) => console.warn('[orchestration]', message)
      })
    }
    if (status === 'completed') {
      this.promoteReadyTasks(id)
    }
    const updatedTask = this.getTask(id)
    commitLifecycleWriteTransaction(this.db, transaction)
    return { task: updatedTask, skipped: [...settlement.skipped] }
  } catch (error) {
    rollbackLifecycleWriteTransaction(this.db, transaction)
    throw error
  }
}

/**
 * The row-returning form every direct caller already uses; `undefined` means "no such Task".
 *
 * Kept because it is the whole answer a caller that is not reporting a settlement needs. A caller that
 * must tell an operator *which* dispatches stayed open uses `updateTaskStatusWithSettlement` instead of
 * asking the database a second question.
 */
export function updateTaskStatus(
  this: OrchestrationDb,
  id: string,
  status: TaskStatus,
  result?: string,
  acceptanceOverride?: AcceptanceOverride
): TaskRow | undefined {
  return applyTaskStatusTransition.call(this, id, status, result, acceptanceOverride).task
}

/** The same transition, returning the settlement helper's exact `skipped` ids alongside the row. */
export function updateTaskStatusWithSettlement(
  this: OrchestrationDb,
  id: string,
  status: TaskStatus,
  result?: string,
  acceptanceOverride?: AcceptanceOverride
): TaskStatusTransitionOutcome {
  return applyTaskStatusTransition.call(this, id, status, result, acceptanceOverride)
}

export type TaskStatusTransitionMethods = {
  updateTaskStatus: typeof updateTaskStatus
  updateTaskStatusWithSettlement: typeof updateTaskStatusWithSettlement
}

export function attachTaskStatusTransition(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { updateTaskStatus, updateTaskStatusWithSettlement })
}
