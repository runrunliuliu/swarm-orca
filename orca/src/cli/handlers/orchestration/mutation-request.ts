import { randomUUID } from 'node:crypto'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { readRetryRequestFlag } from '../../retry-request-flag'
import { orchestrationMutationRecoveryError } from '../../orchestration-mutation-recovery'

const MAX_UNAVAILABLE_RETRY_DELAY_MS = 15_000

export async function callOrchestrationMutation<TResult>(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; orchestrationCapability?: string },
  unavailableRetryMs = 0
) {
  // Why: every retry reuses one request id, so the host replays instead of applying the mutation twice.
  const requestId =
    readRetryRequestFlag(flags) ?? (unavailableRetryMs > 0 ? randomUUID() : undefined)
  const deadline = Date.now() + unavailableRetryMs
  let sentError: RuntimeClientError | undefined
  for (let delayMs = 1_000; ; delayMs = Math.min(delayMs * 2, MAX_UNAVAILABLE_RETRY_DELAY_MS)) {
    try {
      return requestId
        ? await client.call<TResult>(method, params, {
            ...options,
            orchestrationRequestId: requestId
          })
        : options
          ? await client.call<TResult>(method, params, options)
          : await client.call<TResult>(method, params)
    } catch (error) {
      const unavailable =
        error instanceof RuntimeClientError && error.code === 'runtime_unavailable'
      if (carriesRequestId(error)) {
        sentError = error
      }
      // Why: a sandbox or OS permission denial is deterministic — every attempt hits the same
      // fence — so retrying only turns an instant, actionable refusal into a silent hang for the
      // whole retry window (worker_done waits 120 s, long past the agent's patience).
      const refused = error instanceof RuntimeClientError && error.code === 'runtime_access_denied'
      if (refused || !unavailable || Date.now() + delayMs > deadline) {
        // Why: a later attempt can fail before its request id is attached, though an earlier one may have landed.
        throw orchestrationMutationRecoveryError(
          carriesRequestId(error) ? error : (sentError ?? error)
        )
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

function carriesRequestId(error: unknown): error is RuntimeClientError {
  const data: unknown = error instanceof RuntimeClientError ? error.data : undefined
  return (
    typeof data === 'object' &&
    data !== null &&
    'orchestrationRequestId' in data &&
    typeof data.orchestrationRequestId === 'string'
  )
}
