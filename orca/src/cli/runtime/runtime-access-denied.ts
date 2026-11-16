import { existsSync } from 'node:fs'
import type { RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import { RuntimeClientError } from './types'
import { isProcessRunning } from './runtime-pid-liveness'

// Why: `1`, `seatbelt` and any other value mean "a marker is set"; '' and '0' are how a caller
// says "not sandboxed", and reading those as set would hide the real state from the classifier.
function envFlag(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && value !== '' && value !== '0'
}

// Why: the errno decides the classification; these markers only decide whether a failed pid
// probe is evidence at all, and which wording the caller sees.
function codexSandbox(): boolean {
  return envFlag('CODEX_SANDBOX') || envFlag('CODEX_SANDBOX_NETWORK_DISABLED')
}

export function runtimeAccessDeniedError(
  socketError: Error,
  pid: number,
  transport?: RuntimeTransportMetadata | null
): RuntimeClientError | null {
  const systemCode = 'code' in socketError ? socketError.code : undefined
  if (systemCode !== 'EPERM' && systemCode !== 'EACCES') {
    return null
  }
  // Why: only a probe from outside the fence settles whether Orca is still there. Inside a
  // sandbox `process.kill(pid, 0)` answers ESRCH for every host pid, so downgrading a denial to
  // "Orca is not running" on that probe alone told sandboxed workers to restart a healthy app
  // (and the 120 s worker_done retry then hung them with no output). A dead Orca normally leaves
  // a socket that refuses the connect (ECONNREFUSED), not one that denies it — so a denial on a
  // path that exists where the socket should be is not evidence that Orca is gone either.
  // The endpoint test can only ask existsSync, so "a path exists" is all it may claim, and only
  // for a unix socket: `existsSync("\\\\\\.\\pipe\\...")` measures nothing about liveness or
  // permission, so a named pipe never votes here.
  const sandboxed = codexSandbox()
  const orcaRunning = isProcessRunning(pid)
  const seenEndpoint =
    transport?.kind === 'unix' && transport.endpoint !== '' && existsSync(transport.endpoint)
  if (!sandboxed && !orcaRunning && !seenEndpoint) {
    return null
  }
  // Three shapes, and the wording may not claim more than the evidence does: a marker names the
  // fence, a live pid rules the denial down to permissions, and an existing path at the endpoint
  // with a pid the probe cannot see is genuinely undecidable from here (accepted tradeoff: a
  // socket left behind by another user's gone Orca is read as a denial rather than as "Orca is
  // not running").
  const message = sandboxed
    ? `The Codex sandbox blocked this command from connecting to Orca (${systemCode}). Orca may be running normally.`
    : orcaRunning
      ? `Permission denied connecting to Orca (${systemCode}). Orca may be running normally; this command's sandbox or OS permissions block the connection.`
      : `Permission denied connecting to Orca (${systemCode}) on a path that exists where Orca's Unix socket should be. A sandbox or OS permission blocks this command, and that path may also be left over from an Orca that is no longer running; this command cannot tell which.`
  const retryStep = sandboxed
    ? 'Re-run this command with escalated permissions, outside the Codex sandbox.'
    : 'Re-run this command outside its sandbox, or as a user allowed to reach the Orca runtime.'
  const restartStep =
    sandboxed || orcaRunning
      ? ["Do not restart Orca or run 'orca open'; a restart cannot grant this command access."]
      : []
  const probeStep = orcaRunning
    ? []
    : [
        // Why: say this out loud, or the caller concludes from the hidden process that Orca died.
        // Worded for both branches: a marker proves a sandbox, a surviving endpoint does not, and
        // any namespacing has the same effect on the probe.
        `This process cannot see Orca's process (pid ${pid}); a sandbox or other namespacing can hide host pids, so a negative probe is not evidence that Orca stopped.`
      ]
  return new RuntimeClientError('runtime_access_denied', message, {
    systemCode,
    nextSteps: [retryStep, ...restartStep, ...probeStep]
  })
}
