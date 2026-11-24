import process from 'node:process'
import {
  runHistoryBackfillPreflightOnHost,
  type HistoryBackfillPreflightHost
} from '../startup/history-backfill-preflight-run'
import { acquireOrcadInstanceLock, type OrcadInstanceLock } from './orcad-instance-lock'

/**
 * The server-only `orcad` host for the `orca history backfill` preflight.
 *
 * It answers the same launch shape the desktop executable answers
 * (`--serve --history-backfill <json>`) and runs the same write path
 * (`history-backfill-preflight-run.ts`), because the command has to be usable on a
 * host that has no desktop app at all. Only the second fence differs:
 *
 * - the profile-state maintenance owner is still taken by the shared runner;
 * - instead of Electron's `requestSingleInstanceLock`, the data root's own
 *   `orcad.lock` is the fence. A serving orcad holds it, so the preflight refuses
 *   exactly when the desktop refuses — while an app is running — rather than opening
 *   the database underneath a live server.
 *
 * The caller must have installed orcad's host adapters before this runs (the entry
 * point does), so any path read inside the scan resolves through the same
 * `AppEnvironment` the serving process uses.
 */
export function createOrcadHistoryBackfillPreflightHost(
  dependencies: {
    acquireInstanceLock?: (dataRoot: string) => OrcadInstanceLock
    exit?: (exitCode: number) => void
  } = {}
): HistoryBackfillPreflightHost {
  const acquire = dependencies.acquireInstanceLock ?? acquireOrcadInstanceLock
  const exit = dependencies.exit ?? ((exitCode: number) => process.exit(exitCode))
  let userDataPath: string | null = null
  let lock: OrcadInstanceLock | null = null
  return {
    setUserDataPath(path) {
      userDataPath = path
      // Why both names: orcad resolves its data root from ORCA_USER_DATA, while the
      // CLI and the shared profile-state readers use ORCA_USER_DATA_PATH. A child
      // that only set one would scan one tree and write another.
      process.env.ORCA_USER_DATA = path
      process.env.ORCA_USER_DATA_PATH = path
    },
    acquireSingleInstanceLock() {
      if (userDataPath === null) {
        return false
      }
      try {
        lock = acquire(userDataPath)
        return true
      } catch (error) {
        // Why report and refuse instead of throwing: this arm is a normal "the app is
        // running" answer. The prefixed result line stays the existing sentence; this
        // line only preserves the orcad-specific reason (held, foreign identity,
        // unusable root) for the operator's stderr.
        console.error(
          '[orcad] history backfill refused:',
          error instanceof Error ? error.message : String(error)
        )
        return false
      }
    },
    exit(exitCode) {
      lock?.release()
      lock = null
      exit(exitCode)
    }
  }
}

export function runOrcadHistoryBackfillPreflight(
  argv: readonly string[] = process.argv,
  host: HistoryBackfillPreflightHost = createOrcadHistoryBackfillPreflightHost()
): boolean {
  return runHistoryBackfillPreflightOnHost(argv, host)
}
