// M4: the sweep that makes the journal useful without anyone remembering to ask.
//
// A create that was killed (crash, restart, lost response) leaves a `pending` record. Until now that
// record only got classified when a human ran `worktree create-status`. At process start nothing of
// this process can be in flight yet, so every older `pending` is fair game to observe — and only to
// observe: the sweep annotates what it saw and never settles, cleans or retries anything.

import {
  classifySparseTaskCreateOutcome,
  inspectSparseTaskCreate
} from './sparse-task-create-reconciliation'
import {
  readAllUnsettledSparseTaskCreates,
  recordSparseTaskCreateObservation
} from './sparse-task-create-journal'

/** Captured when the module loads, which is process start for every entry point that sweeps. */
const PROCESS_STARTED_AT = Date.now()

/** How many attempts one sweep will look at; a first run on a busy host must stay bounded. */
const MAX_ATTEMPTS_PER_SWEEP = 20

export type TaskCreateStartupSweepResult = {
  inspected: number
  /** Attempts whose probe or annotation failed; they stay `pending` and are retried next start. */
  failed: number
  /** Attempts recorded after this process started: possibly still running, so untouched. */
  skippedInFlight: number
}

/**
 * Classify every `pending` task create recorded before this process started.
 *
 * Why fire-and-forget callers: startup must not fail or block because a diagnostic annotation could
 * not be written. Every failure is counted, logged once, and otherwise ignored.
 */
export async function sweepTaskCreateJournalOnStart(
  args: {
    startedBefore?: number
    inspector?: typeof inspectSparseTaskCreate
    limit?: number
  } = {}
): Promise<TaskCreateStartupSweepResult> {
  const startedBefore = args.startedBefore ?? PROCESS_STARTED_AT
  const inspect = args.inspector ?? inspectSparseTaskCreate
  const limit = args.limit ?? MAX_ATTEMPTS_PER_SWEEP
  const result: TaskCreateStartupSweepResult = { inspected: 0, failed: 0, skippedInFlight: 0 }

  let attempts
  try {
    attempts = await readAllUnsettledSparseTaskCreates()
  } catch (error) {
    console.warn('[sparse-task] startup sweep could not read the create journal:', error)
    return result
  }
  for (const attempt of attempts) {
    if (result.inspected + result.failed >= limit) {
      break
    }
    if (attempt.updatedAt >= startedBefore) {
      result.skippedInFlight += 1
      continue
    }
    try {
      const inspection = await inspect({
        repoPath: attempt.repoPath,
        worktreePath: attempt.worktreePath,
        branch: attempt.branch,
        pin: { pinnedSha: attempt.pinnedSha },
        requestedSparseCone: attempt.requestedSparseCone,
        requiredPaths: attempt.requiredPaths
      })
      await recordSparseTaskCreateObservation({
        repoId: attempt.repoId,
        requestId: attempt.requestId,
        observation: {
          state: classifySparseTaskCreateOutcome(inspection),
          at: Date.now(),
          reasons: inspection.reasons.slice(0, 10)
        }
      })
      result.inspected += 1
    } catch (error) {
      result.failed += 1
      console.warn(
        `[sparse-task] startup sweep could not inspect create ${attempt.requestId}:`,
        error
      )
    }
  }
  if (result.inspected > 0 || result.failed > 0) {
    console.info('[sparse-task] startup sweep', result)
  }
  return result
}
