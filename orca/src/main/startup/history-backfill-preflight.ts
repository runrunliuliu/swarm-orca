import { app } from 'electron'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'
import { acquireSingleInstanceLock } from './single-instance-lock'
import { runHistoryBackfillPreflightOnHost } from './history-backfill-preflight-run'

export type { HistoryBackfillPreflightHost } from './history-backfill-preflight-run'

/**
 * `orca history backfill` (issue #53 B) executes here, in the Orca executable,
 * before Electron can initialize a runtime — mirroring
 * `profile-state-recovery-preflight.ts`, and for the same two reasons:
 *
 * - the profile-state maintenance lock must be held by a process that never becomes
 *   the app, otherwise the app's in-memory revision would overwrite the backfill;
 * - the agent session index lives in this build's main graph, and the CLI bundle
 *   deliberately does not compile it.
 *
 * The write path itself is `history-backfill-preflight-run.ts`, shared with the
 * server-only `orcad` host so the two builds cannot drift. This wrapper only supplies
 * Electron's `app` as the two locks and the exit.
 */
export function runHistoryBackfillPreflight(argv: readonly string[] = process.argv): boolean {
  return runHistoryBackfillPreflightOnHost(argv, {
    setUserDataPath(userDataPath) {
      app.setPath('userData', userDataPath)
      process.env.ORCA_USER_DATA_PATH = userDataPath
    },
    // Why forced on: the preflight must refuse while any app owns this profile, even
    // for a launch form whose ordinary startup would bypass the lock.
    acquireSingleInstanceLock: () => acquireSingleInstanceLock(app, () => {}),
    exit: (exitCode) => app.exit(exitCode),
    applyBackgroundActivationPolicy
  })
}
