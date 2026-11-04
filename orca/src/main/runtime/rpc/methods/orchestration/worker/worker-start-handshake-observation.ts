import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { matchesWorkerStartupHandshake } from '../../../../orchestration/worker-startup-handshake'

export type WorkerStartupHandshakeObservation =
  | { verdict: 'observed'; messageId: string }
  | { verdict: 'unobserved'; reason: string }

const UNCONFIRMED_STARTUP =
  'Dispatch input was submitted, but the startup command callback could not be verified. ' +
  'The worker is unverifiable, not proven dead. Its task and terminal are retained; do not ' +
  'resend the task blindly. If the worker recovers and reports, this Dispatch settles normally.'

export async function observeWorkerStartupHandshake(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  taskId: string
  dispatchId: string
  terminalHandle: string
  threadId: string
  timeoutMs?: number
}): Promise<WorkerStartupHandshakeObservation> {
  const { runtime, db, terminalHandle } = args
  const deadline = Date.now() + (args.timeoutMs ?? AGENT_PROMPT_EFFECT_TIMEOUT_MS)
  let afterSequence: number | undefined
  try {
    for (;;) {
      const paneKey = runtime.getTerminalPaneKey(terminalHandle)
      if (
        !paneKey ||
        !db.isDispatchProcessCurrent({
          dispatchId: args.dispatchId,
          paneKey,
          processIncarnation: runtime.getTerminalProcessIncarnation(terminalHandle)
        })
      ) {
        return {
          verdict: 'unobserved',
          reason: `Worker process identity changed or became unavailable. ${UNCONFIRMED_STARTUP}`
        }
      }
      // Durable reads also see callbacks the coordinator already consumed, without taking its waiter.
      const messages = db.getThreadMessagesFor(args.threadId, `run:${args.runId}`, afterSequence)
      const callback = messages.find((message) =>
        matchesWorkerStartupHandshake(message, { ...args, workerHandle: terminalHandle, paneKey })
      )
      if (callback) {
        return { verdict: 'observed', messageId: callback.id }
      }
      afterSequence = messages.at(-1)?.sequence ?? afterSequence
      if (db.getWorkerDispatch(args.dispatchId)?.state !== 'starting') {
        break
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)))
    }
  } catch {
    // Losing observation after an accepted write must not tear down potentially live work.
  }
  return { verdict: 'unobserved', reason: UNCONFIRMED_STARTUP }
}
