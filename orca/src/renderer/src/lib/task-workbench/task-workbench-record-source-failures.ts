import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import type { TaskRecordSourceFailure } from './task-workbench-record-sources'

/**
 * Turn one failed `taskRecords.get` into the reason the panel prints (issue #31).
 *
 * Why this is a separate, pure function: the panel's copy is a claim about the
 * remote host, and the claim may only be as strong as the evidence. "The host is
 * older than this client" (unsupported), "this client may not read that host"
 * (forbidden), "the host does not know this repository" (repo-unknown) and "the
 * connection did not carry an answer" (unreachable) are four different sentences,
 * and none of them is "this task has no history".
 *
 * Why the shared token matcher and not a class check: Electron IPC and the relay
 * re-wrap a failure and flatten its code into the message, so `hasRuntimeRpcErrorCode`
 * is the one matcher that sees every shape a client actually receives.
 *
 * Unrecognised failures are `unreachable`, never `unsupported`: telling a user
 * their server is out of date because of an unrelated transport error would send
 * them to an upgrade that fixes nothing. The default is the retryable verdict.
 */
export function classifyTaskRecordsRemoteFailure(error: unknown): TaskRecordSourceFailure {
  if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
    return 'unsupported'
  }
  if (
    hasRuntimeRpcErrorCode(error, 'forbidden') ||
    hasRuntimeRpcErrorCode(error, 'unauthorized')
  ) {
    return 'forbidden'
  }
  // A host outside the client's protocol window is the version-gap case the
  // capability advertisement exists for; it cannot be asked at all.
  if (isRuntimeCompatBlockError(error)) {
    return 'unsupported'
  }
  // A host that cannot answer right now (busy, restarting, timed out) is a retry,
  // not a version verdict.
  return 'unreachable'
}
