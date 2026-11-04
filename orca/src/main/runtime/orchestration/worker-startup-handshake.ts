import { hasLifecycleRejectionMarker } from './db/lifecycle-rejection-marker'
import { isEquivalentPaneKey } from './db/pane-key-match'
import type { MessageRow } from './types'

type StartupHandshakeTarget = {
  threadId: string
  taskId: string
  dispatchId: string
  workerHandle: string
}

const STARTUP_SUBJECT = 'worker_started'
const STARTUP_PHASE = 'startup'

export function buildWorkerStartupHandshakeInstructions(
  target: StartupHandshakeTarget & { cli: string }
): string {
  return `=== STARTUP CHECK (ONCE) ===
Before any task work, execute this command exactly once in your shell; printing or
echoing it is not a startup check. After it succeeds, continue with the TASK below
in this same turn. Do not wait for another prompt, and do not send worker_done for
this check — worker_done is only for the actual task outcome.

Honor the workspace's execution and approval rules for this command too. If the
required permission cannot be requested or is denied, stop before task work and
leave the blocker in this terminal. Do not switch tools, omit required approval,
change the CLI entrypoint, or claim that the heartbeat was sent. If the result is
unknown, do not resend or begin task work; the coordinator must check durable state.

\`\`\`sh
${target.cli} orchestration send --from ${target.workerHandle} --type heartbeat --subject "${STARTUP_SUBJECT}" --task-id ${target.taskId} --dispatch-id ${target.dispatchId} --phase "${STARTUP_PHASE}" --thread-id ${target.threadId}
\`\`\`

`
}

export function matchesWorkerStartupHandshake(
  message: MessageRow,
  target: StartupHandshakeTarget & { runId: string; paneKey: string }
): boolean {
  if (
    message.type !== 'heartbeat' ||
    message.subject !== STARTUP_SUBJECT ||
    message.thread_id !== target.threadId ||
    message.run_id !== target.runId ||
    message.to_handle !== `run:${target.runId}` ||
    message.from_handle !== target.workerHandle ||
    !message.sender_pane_key ||
    !isEquivalentPaneKey(message.sender_pane_key, target.paneKey) ||
    hasLifecycleRejectionMarker(message.payload)
  ) {
    return false
  }
  try {
    const payload: unknown = JSON.parse(message.payload ?? 'null')
    return Boolean(
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'taskId' in payload &&
      payload.taskId === target.taskId &&
      'dispatchId' in payload &&
      payload.dispatchId === target.dispatchId &&
      'phase' in payload &&
      payload.phase === STARTUP_PHASE
    )
  } catch {
    return false
  }
}
