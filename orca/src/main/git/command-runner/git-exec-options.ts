// Why: cap execFile output to prevent an uncatchable V8 string overflow; match relay MAX_GIT_BUFFER.
export const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024

// Why: the admission tier is a wire value, so it is declared with its params schema.
import type { GitAdmissionTier } from '../../../shared/rpc-contract/git-admission-tier-params'

export type { GitAdmissionTier }

export type GitExecOptions = {
  cwd: string
  encoding?: BufferEncoding | 'buffer'
  maxBuffer?: number
  timeout?: number
  /** Overrides only the default read deadline in tests; explicit timeout still wins. */
  timeoutMsForTest?: number
  stdin?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  wslDistro?: string
  preferWslDirectGit?: boolean
  useConfiguredSshCommandForNetwork?: boolean
  terminationBarrier?: boolean
  captureWslLoginShellOutput?: boolean
  /** Stop waiting at the deadline without killing the child.
   *  Why: a killed mutation can delete what it was still writing (`git worktree add`), so the one
   *  caller that owns a slow checkout asks for the deadline to end the wait alone. The
   *  termination-barrier path (WSL) keeps killing: its barrier owns process-group teardown. */
  keepRunningOnTimeout?: boolean
  /** Scheduler priority for this child; status is the safe default. */
  admissionTier?: GitAdmissionTier
}
