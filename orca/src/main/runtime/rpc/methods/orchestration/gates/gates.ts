import { defineMethod } from '../../../core'
import type { GateStatus } from '../../../../orchestration/db'
import { precomputeActiveDispatchAcceptance } from '../../../../orchestration/db/dispatch-context/dispatch-completion'
import { Coordinator } from '../../../../orchestration/coordinator'
import { resolveRunScope } from '../runs/run-scope'
import { taskNotFoundError } from '../../../../orchestration/task-dispatch-refusal'
import {
  GateCreateParams,
  GateListParams,
  GateResolveParams,
  RunParams,
  RunStopParams
} from '../../../../../../shared/rpc-contract/orchestration-gates-params'

// Why: the coordinator instance is stored at module scope so orchestration.runStop
// can signal it to halt. Only one coordinator can run at a time (enforced by
// the DB's active-run check), so a single reference suffices.
let activeCoordinator: Coordinator | null = null

export const ORCHESTRATION_GATE_METHODS = [
  // Why: Section 4.12 — orchestration.run returns immediately with a run ID.
  // The coordinator loop runs in the background; progress is queried via
  // orchestration.taskList. This prevents the RPC call from blocking the
  // CLI (or any caller) for the entire duration of the pipeline.
  defineMethod({
    name: 'orchestration.run',
    params: RunParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()

      const existing = db.getActiveCoordinatorRun()
      if (existing) {
        throw new Error(`Coordinator already running: ${existing.id}`)
      }

      const coordinatorHandle = params.from ?? 'coordinator'
      const coordinator = new Coordinator(db, runtime, {
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs,
        maxConcurrent: params.maxConcurrent,
        worktree: params.worktree
      })

      activeCoordinator = coordinator

      const run = db.createCoordinatorRun({
        spec: params.spec,
        coordinatorHandle,
        pollIntervalMs: params.pollIntervalMs
      })

      // Why: fire-and-forget — the coordinator loop runs in the event loop
      // background. Results are persisted to the DB; callers query via
      // orchestration.taskList or orchestration.runStatus.
      coordinator.runFromExistingRun(run.id).finally(() => {
        if (activeCoordinator === coordinator) {
          activeCoordinator = null
        }
      })

      return { runId: run.id, status: 'running' }
    }
  }),

  defineMethod({
    name: 'orchestration.runStop',
    params: RunStopParams,
    handler: (_params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const run = db.getActiveCoordinatorRun()
      if (!run) {
        throw new Error('No active coordinator run')
      }

      if (activeCoordinator) {
        activeCoordinator.stop()
        activeCoordinator = null
      }

      return { runId: run.id, stopped: true }
    }
  }),

  defineMethod({
    name: 'orchestration.gateCreate',
    params: GateCreateParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      let options: string[] | undefined
      if (params.options) {
        try {
          const parsed = JSON.parse(params.options)
          if (!Array.isArray(parsed) || !parsed.every((option) => typeof option === 'string')) {
            throw new Error('not an array of strings')
          }
          options = parsed
        } catch {
          throw new Error('Invalid --options: must be a JSON array of strings')
        }
      }
      const task = db.getTask(params.task)
      if (!task) {
        throw new Error(`Task not found: ${params.task}`)
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      if (task.run_id !== run.id) {
        throw taskNotFoundError(`Task ${params.task} was not found in Run ${run.id}.`, {
          taskId: params.task,
          runId: run.id
        })
      }
      // Why the acceptance decision is computed here, before `createGate` opens its write transaction:
      // creating a gate settles the Task's active Dispatches, and the acceptance gate writes incidents
      // and an acceptance stop into a *second* database (`incidents/acceptance-gate.ts:10-17`).
      // `createGate` then only applies this map: a dispatch it has no entry for is left unsettled —
      // fail-closed — instead of being decided while the lifecycle WAL writer is held.
      const acceptanceDecisions = precomputeActiveDispatchAcceptance(db, params.task, {
        ...(params.overrideAcceptance === undefined
          ? {}
          : { acceptanceOverride: params.overrideAcceptance })
      })
      const { gate, skipped } = db.createGateWithSettlement({
        taskId: params.task,
        question: params.question,
        options,
        acceptanceDecisions,
        log: (message) => console.warn('[orchestration]', message)
      })
      // B-F10: opening a gate settles the Task's active Dispatches, so it can leave some unsettled for
      // the same reasons a Task terminal does (acceptance blocked, or no decision for a newcomer).
      // The ids are the settlement helper's own answer — gate-create used to be silent about them.
      return skipped.length === 0 ? { gate } : { gate, skippedAcceptance: skipped }
    }
  }),

  defineMethod({
    name: 'orchestration.gateResolve',
    params: GateResolveParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const existing = db.getGate(params.id)
      if (!existing) {
        throw new Error(`Gate not found: ${params.id}`)
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      // Why: a gate outside the caller's Run is indistinguishable from a missing one, so probing cannot map foreign Runs.
      if (existing.run_id !== run.id) {
        throw new Error(`Gate not found: ${params.id}`)
      }
      const gate = db.resolveGate(params.id, params.resolution)
      if (!gate) {
        throw new Error(`Gate not found: ${params.id}`)
      }
      return { gate }
    }
  }),

  defineMethod({
    name: 'orchestration.gateList',
    params: GateListParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      // Why: same read posture as taskList — an explicitly named Run is inspectable, an unnamed one means the caller's own.
      const run =
        explicitRun?.legacy === 1
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.from,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence,
              callerSession: orchestrationCaller
            })
      const gates = db
        .listGates({
          taskId: params.task,
          status: params.status as GateStatus
        })
        .filter((gate) => gate.run_id === run.id)
      return { runId: run.id, gates, count: gates.length }
    }
  })
]
