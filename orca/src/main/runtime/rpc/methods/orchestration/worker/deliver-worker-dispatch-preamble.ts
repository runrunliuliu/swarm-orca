import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  buildDispatchPreamble,
  dispatchPreambleSendOptions
} from '../../../../orchestration/preamble'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'
import type { WorkerTurnStartObservation } from './worker-start-turn-observation'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'
import { strictCoordinatorPolicy } from '../../../../orchestration/strict-coordinator-policy'
import { assertStrictDispatchWorker } from '../../../strict-coordinator-authority'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null

/** Deliver the same preamble via PTY, structured session, or a durable Dispatch inbox. */
export async function deliverWorkerDispatchPreamble(args: {
  runtime: OrcaRuntimeService
  mailbox?: { db: OrchestrationDb; runId: string }
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode: boolean | undefined
  requestId: string
  startupHandshakeThreadId?: string
  revalidateCoordinator?: () => void
}): Promise<{
  prompt?: RuntimeTerminalSend['prompt']
  structuredTurnStart?: WorkerTurnStartObservation
}> {
  const { runtime, structuredSession, terminalHandle } = args
  const db = runtime.getExistingOrchestrationDb?.()
  const dispatch = db?.getDispatchContextById(args.dispatchId)
  const strict = db && dispatch && strictCoordinatorPolicy(db, dispatch.run_id)
  const revalidate = () => {
    args.revalidateCoordinator?.()
    assertStrictDispatchWorker(runtime, args.dispatchId)
  }
  revalidate()
  const preamble = buildDispatchPreamble({
    canDispatchSubWorkers: !strict && args.dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId: args.taskId,
    dispatchId: args.dispatchId,
    taskSpec: args.taskSpec,
    coordinatorHandle: args.coordinatorHandle,
    workerHandle: terminalHandle,
    startupHandshakeThreadId: args.startupHandshakeThreadId,
    devMode: args.devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  })
  if (structuredSession) {
    const delivery = await sendStructuredWorkerPreamble({
      host: structuredSession.host,
      sessionId: structuredSession.identity.sessionId,
      dispatchId: args.dispatchId,
      preamble
    })
    return {
      structuredTurnStart:
        delivery === 'accepted'
          ? { verdict: 'observed' }
          : {
              verdict: 'unobserved',
              reason:
                'The dispatch preamble was accepted, but the agent had not started to take it. It ' +
                'is delivered when the agent starts; if the worker then reports, this Dispatch ' +
                'settles normally.'
            }
    }
  }
  if (args.mailbox) {
    const address = `dispatch:${args.dispatchId}`
    args.mailbox.db.insertMessage({
      from: args.coordinatorHandle,
      to: address,
      runId: args.mailbox.runId,
      senderPaneKey: runtime.getTerminalPaneKey(args.coordinatorHandle) ?? undefined,
      type: 'dispatch',
      subject: 'worker_dispatch_preamble',
      body: preamble,
      payload: JSON.stringify({ taskId: args.taskId, dispatchId: args.dispatchId }),
      deliveryContract: 'current_delivery'
    })
    // Persistence is delivery; a lost wake-up must never turn accepted work into a failed start.
    // Wake a pre-binding direct check too; its next bounded check finds the Dispatch mailbox.
    for (const recipient of [address, terminalHandle]) {
      try {
        runtime.notifyMessageArrived(recipient, 'dispatch')
      } catch {
        // The bootstrap's bounded check also polls the durable inbox after a missed nudge.
      }
    }
    return {}
  }
  return {
    prompt: (
      await runtime.sendTerminalAgentPrompt(terminalHandle, preamble, {
        ...dispatchPreambleSendOptions(args.requestId),
        beforeWrite: revalidate
      })
    ).prompt
  }
}
