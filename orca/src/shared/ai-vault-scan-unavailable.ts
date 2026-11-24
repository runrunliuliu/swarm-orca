/**
 * The typed "this host cannot run a session scan at all" answer.
 *
 * Why a type and not a message test: the condition is decided by a `stat`-like check
 * before any child exists (the scan entry is not in this build), so the thrower knows
 * it and no caller should have to re-derive it from a string. Two callers have to act
 * on it and they must not disagree:
 *
 * - the scanner supervisors, which must not requeue it as if it were a transient cold
 *   start (a respawn cannot conjure a file that is not installed);
 * - the one-shot history backfill, which must refuse rather than record the "no session
 *   for this workspace" gap a scan it never ran cannot prove.
 *
 * The messages stay byte-identical to the ones both spawners threw before this type
 * existed, because `describeAiVaultScanError` (shared with the renderer, untouched here)
 * matches them to reach its "the session scanner is missing from this install" copy.
 */
export const AI_VAULT_SCAN_UNAVAILABLE_CODE = 'ai_vault_scan_unavailable'

export class AiVaultScanUnavailableError extends Error {
  readonly code = AI_VAULT_SCAN_UNAVAILABLE_CODE

  constructor(
    message: string,
    /** The entry this host looked for and did not find, verbatim for the operator. */
    readonly entryPath: string
  ) {
    super(message)
    this.name = 'AiVaultScanUnavailableError'
  }
}

/** The forked service entry (`session-scanner-service-entry.js`) is not in this build. */
export function createAiVaultServiceEntryMissingError(
  entryPath: string
): AiVaultScanUnavailableError {
  return new AiVaultScanUnavailableError(
    `AI Vault service entry not found: ${entryPath}`,
    entryPath
  )
}

/** The legacy worker-thread entry (`session-scanner-worker-entry.js`) is not in this build. */
export function createAiVaultWorkerEntryMissingError(
  entryPath: string
): AiVaultScanUnavailableError {
  return new AiVaultScanUnavailableError(
    `AI Vault scanner worker entry not found: ${entryPath}`,
    entryPath
  )
}

/** Matched by `code`, not `instanceof`: a mocked or duplicated module instance must not
 *  turn a deterministic refusal back into "transient". */
export function isAiVaultScanUnavailableError(
  error: unknown
): error is AiVaultScanUnavailableError {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === AI_VAULT_SCAN_UNAVAILABLE_CODE &&
    'entryPath' in error &&
    typeof error.entryPath === 'string'
  )
}
