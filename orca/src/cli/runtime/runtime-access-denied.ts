import { existsSync } from 'node:fs'
import { RuntimeClientError } from './types'
import { isProcessRunning } from './runtime-pid-liveness'

// Why: the errno decides the classification; these markers only decide whether a failed pid
// probe is evidence at all, and which wording the caller sees.
function codexSandbox(): boolean {
  const networkDisabled = process.env.CODEX_SANDBOX_NETWORK_DISABLED
  return Boolean(
    process.env.CODEX_SANDBOX ||
    (networkDisabled !== undefined && networkDisabled !== '' && networkDisabled !== '0')
  )
}

// Why: a present socket file that answered EPERM was not absent, so the denial is permission:
// a missing path would have produced ENOENT before any listener question came up.
function endpointPresent(endpoint: string | undefined): boolean {
  return endpoint !== undefined && endpoint !== '' && existsSync(endpoint)
}

export function runtimeAccessDeniedError(
  socketError: Error,
  pid: number,
  endpoint?: string
): RuntimeClientError | null {
  const systemCode = 'code' in socketError ? socketError.code : undefined
  if (systemCode !== 'EPERM' && systemCode !== 'EACCES') {
    return null
  }
  // Why: only a probe from outside the fence settles whether Orca is still there. Inside a
  // sandbox `process.kill(pid, 0)` answers ESRCH for every host pid, so downgrading a denial to
  // "Orca is not running" on that probe alone told sandboxed workers to restart a healthy app
  // (and the 120 s worker_done retry then hung them with no output). A dead Orca normally leaves
  // a socket that refuses the connect (ECONNREFUSED), not one that denies it.
  const sandboxed = codexSandbox()
  const orcaRunning = isProcessRunning(pid)
  if (!orcaRunning && !sandboxed && !endpointPresent(endpoint)) {
    return null
  }
  const message = sandboxed
    ? `The Codex sandbox blocked this command from connecting to Orca (${systemCode}). Orca may be running normally.`
    : `Permission denied connecting to Orca (${systemCode}). Orca may be running normally; this command's sandbox or OS permissions block the connection.`
  const retryStep = sandboxed
    ? 'Re-run this command with escalated permissions, outside the Codex sandbox.'
    : 'Re-run this command outside its sandbox, or as a user allowed to reach the Orca runtime.'
  const probeStep = orcaRunning
    ? []
    : [
        // Why: say this out loud, or the caller concludes from the hidden process that Orca died.
        `This process cannot see Orca's process either (pid ${pid}), which is what a sandbox process namespace does; that probe is not evidence that Orca stopped.`
      ]
  return new RuntimeClientError('runtime_access_denied', message, {
    systemCode,
    nextSteps: [
      retryStep,
      "Do not restart Orca or run 'orca open'; a restart cannot grant this command access.",
      ...probeStep
    ]
  })
}
