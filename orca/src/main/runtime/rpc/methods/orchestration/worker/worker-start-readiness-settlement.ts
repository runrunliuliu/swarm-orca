import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
import type { OrchestrationWorkerLaunchReceipt } from './worker-launch-preferences'
import {
  describeUnobservedWorkerTurnStart,
  observeWorkerTurnStart,
  type WorkerTurnStartObservation
} from './worker-start-turn-observation'
import { observeWorkerStartupHandshake } from './worker-start-handshake-observation'
import {
  monitorWorkerSetup,
  type createStructuredWorkerSessionForWorktree,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './worker-topology'

/**
 * Delivers the dispatch preamble and settles the worker's start state on the strongest
 * evidence available. Fresh Trae workers must execute the startup command; other workers
 * retain their native turn-start contract.
 */
export async function deliverAndSettleWorkerStartReadiness(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  task: TaskRow
  dispatchId: string
  dispatchDepth: number
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  terminalHandle: string
  coordinatorHandle: string
  devMode: boolean | undefined
  requestId: string
  agent: string | null
  requireStartupHandshake?: boolean
  revalidateCoordinator?: () => void
  preambleTransport?: 'mailbox'
  setupReceipt: WorkerSetupReceipt
  launchReceipt: OrchestrationWorkerLaunchReceipt
  mode: WorkerStartModeReceipt
  timeoutMs: number
  effects: WorkerEffect[]
  terminalRevealWarning: string | undefined
  /** Keeps the caller's failure receipt naming the stage that actually failed. */
  onStage: (stage: 'dispatch_input' | 'turn_observation') => void
}): Promise<unknown> {
  const { runtime, db, run, task, structuredSession, terminalHandle, effects } = args
  const startupHandshakeThreadId =
    args.requireStartupHandshake && !structuredSession ? randomUUID() : undefined

  args.onStage('dispatch_input')
  const delivery = await deliverWorkerDispatchPreamble({
    runtime,
    revalidateCoordinator: args.revalidateCoordinator,
    mailbox: args.preambleTransport === 'mailbox' ? { db, runId: run.id } : undefined,
    structuredSession,
    terminalHandle,
    dispatchId: args.dispatchId,
    dispatchDepth: args.dispatchDepth,
    taskId: task.id,
    taskSpec: task.spec,
    coordinatorHandle: args.coordinatorHandle,
    devMode: args.devMode,
    requestId: args.requestId,
    startupHandshakeThreadId
  })
  effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: terminalHandle,
    state: 'accepted'
  })

  args.onStage('turn_observation')
  const promptDelivery = delivery.prompt
  const [turnStart, startupHandshake]: [
    WorkerTurnStartObservation,
    Awaited<ReturnType<typeof observeWorkerStartupHandshake>> | undefined
  ] = await Promise.all([
    delivery.structuredTurnStart ??
      observeWorkerTurnStart({
        runtime,
        terminalHandle,
        prompt: promptDelivery,
        // The executable handshake owns Trae's observation budget; keep the native receipt truthful.
        ...(startupHandshakeThreadId ? { timeoutMs: 0 } : {})
      }),
    startupHandshakeThreadId
      ? observeWorkerStartupHandshake({
          runtime,
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: args.dispatchId,
          terminalHandle,
          threadId: startupHandshakeThreadId,
          ...(args.preambleTransport === 'mailbox' ? { timeoutMs: args.timeoutMs } : {})
        })
      : undefined
  ])
  const handshakeReceipt = startupHandshake
    ? { startupHandshake: { threadId: startupHandshakeThreadId, ...startupHandshake } }
    : {}
  if (startupHandshake) {
    effects.push({
      kind: 'dispatch_input',
      action: 'startup_handshake',
      id: startupHandshakeThreadId,
      state: startupHandshake.verdict
    })
  }
  const deliveredPrompt = turnStart.prompt ?? promptDelivery
  monitorWorkerSetup({
    runtime,
    db,
    runId: run.id,
    dispatchId: args.dispatchId,
    setupReceipt: args.setupReceipt,
    effects
  })
  // A worker report can settle the dispatch while turn observation is outstanding.
  const currentWorker = db.getWorkerDispatch(args.dispatchId)
  const alreadySettled = currentWorker && currentWorker.state !== 'starting'
  const startUnobserved = startupHandshake
    ? startupHandshake.verdict === 'unobserved'
    : turnStart.verdict === 'unobserved'
  if (startUnobserved && !alreadySettled) {
    // Honest `unverifiable`: keep lifecycle authority and the terminal — the worker may
    // still recover and report (worker-report settlement reconnects a start_unknown worker) —
    // but never claim ready for a turn nobody observed.
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: startupHandshake ? 'startup_handshake_unobserved' : 'turn_unobserved'
    })
    const reason =
      startupHandshake?.verdict === 'unobserved'
        ? startupHandshake.reason
        : (turnStart.reason ?? describeUnobservedWorkerTurnStart(args.agent))
    const worker = db.markWorkerStartUnknown(
      args.dispatchId,
      startupHandshake ? 'startup_handshake_unobserved' : 'turn_start_unobserved',
      reason,
      effects
    )
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId: args.dispatchId,
      state: 'outcome_unknown',
      stage: worker.stage,
      turnStart: turnStart.verdict,
      ...handshakeReceipt,
      lastError: reason,
      setup: args.setupReceipt,
      launch: args.launchReceipt,
      mode: args.mode,
      timeoutMs: args.timeoutMs,
      effects,
      ...(deliveredPrompt ? { prompt: deliveredPrompt } : {}),
      residualResources: JSON.parse(worker.residual_resources) as unknown[],
      nextCommands: [
        `orca orchestration worker-show --dispatch ${args.dispatchId} --json`,
        // A structured worker has no screen to read.
        ...(structuredSession ? [] : [`orca terminal read --terminal ${terminalHandle} --screen`]),
        `orca orchestration worker-abandon --dispatch ${args.dispatchId} --json`
      ],
      ...(args.terminalRevealWarning ? { warning: args.terminalRevealWarning } : {})
    }
  }
  const worker = alreadySettled
    ? currentWorker
    : db.markWorkerDispatchReady(args.dispatchId, effects)
  // A completed task proves start succeeded; older callers use only 'ready' as start success.
  const reportedOutcome =
    worker.stage === 'settled' && (worker.state === 'succeeded' || worker.state === 'failed')
      ? worker.state
      : undefined
  return {
    runId: run.id,
    taskId: task.id,
    dispatchId: args.dispatchId,
    state: reportedOutcome ? 'ready' : worker.state,
    stage: worker.stage,
    ...(reportedOutcome ? { workerOutcome: reportedOutcome } : {}),
    turnStart: turnStart.verdict,
    ...handshakeReceipt,
    setup: args.setupReceipt,
    launch: args.launchReceipt,
    mode: args.mode,
    timeoutMs: args.timeoutMs,
    effects,
    ...(deliveredPrompt ? { prompt: deliveredPrompt } : {}),
    residualResources: [],
    ...(args.terminalRevealWarning ? { warning: args.terminalRevealWarning } : {})
  }
}
