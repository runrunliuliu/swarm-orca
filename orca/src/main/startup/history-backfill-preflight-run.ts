import { realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillRequestSchema,
  isHistoryBackfillCommandError,
  type HistoryBackfillResponse
} from '../../shared/history-backfill-command'
import { getActiveProfileStateLocation } from '../persistence/profile-state/profile-state-active-location'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/profile-state-access'
import { backfillTaskRecords } from '../task-records/task-records-backfill-profile-state'
import { createAiVaultSessionIndexLookup } from '../task-records/task-records-session-index-lookup'
import { createTranscriptCheckProbe } from '../task-records/task-records-transcript-check'

/**
 * The process-independent half of the `orca history backfill` preflight.
 *
 * Why this module exists separately from `history-backfill-preflight.ts`: the write
 * path has to run in two different hosts — the Electron app and the server-only
 * `orcad` artifact — and only the locks that fence it differ. Keeping the parse,
 * the maintenance owner, the scan and the one prefixed result line here means both
 * hosts execute the same contract instead of a copy that can drift. This module
 * must stay free of `electron`; it is reachable from `src/main/orcad/main.ts`, whose
 * bundle refuses an Electron importer (`config/scripts/build-orcad.mjs`).
 *
 * Contract (unchanged from the desktop preflight): one `HISTORY_BACKFILL_FLAG`
 * occurrence, only with `--serve`, followed by the JSON request; one prefixed result
 * line on stdout; exit code 0 only for a completed run. Never fall through into
 * ordinary startup (the caller returns out of its preflight when this returns true).
 */
export type HistoryBackfillPreflightHost = {
  /**
   * Bind the canonical profile root before a lock or a read. The host also owns
   * whatever environment its build resolves paths from (`ORCA_USER_DATA_PATH` for
   * the desktop, both names for orcad).
   */
  setUserDataPath: (userDataPath: string) => void
  /**
   * The second fence, taken after the maintenance owner. `false` means another
   * process owns this profile and the command is refused with the existing
   * "Stop Orca" sentence; it never means "write anyway".
   */
  acquireSingleInstanceLock: () => boolean
  /** Write the result and leave. Production implementations never return. */
  exit: (exitCode: number) => void
  /** Desktop-only: a headless host has no windows to deactivate. */
  applyBackgroundActivationPolicy?: () => void
}

export function runHistoryBackfillPreflightOnHost(
  argv: readonly string[],
  host: HistoryBackfillPreflightHost
): boolean {
  const index = argv.indexOf(HISTORY_BACKFILL_FLAG)
  if (index === -1) {
    return false
  }
  process.env.ORCA_BACKGROUND_LAUNCH = '1'
  host.applyBackgroundActivationPolicy?.()
  const launchValid = argv.includes('--serve') && argv.lastIndexOf(HISTORY_BACKFILL_FLAG) === index
  const finish = (response: HistoryBackfillResponse): void => {
    let exitCode = response.ok ? 0 : 1
    try {
      writeFileSync(1, `${HISTORY_BACKFILL_RESULT_PREFIX}${JSON.stringify(response)}\n`)
    } catch {
      // The CLI may have exited while this process held the locks; never open an error dialog.
      exitCode = 1
    }
    host.exit(exitCode)
  }
  if (!launchValid) {
    finish(invalidLaunch())
    return true
  }
  // The scan is asynchronous, so the exit happens when it settles rather than on
  // return. Nothing below may throw past `finish`; a launch that dies silently would
  // look to the CLI like a crash, not like a refused command.
  void runBackfillRequest(argv[index + 1], host).then(finish, (error: unknown) =>
    finish({
      ok: false,
      code: 'runtime_error',
      message: error instanceof Error ? error.message : String(error)
    })
  )
  return true
}

async function runBackfillRequest(
  payload: string | undefined,
  host: HistoryBackfillPreflightHost
): Promise<HistoryBackfillResponse> {
  try {
    let raw: unknown
    try {
      raw = JSON.parse(payload ?? '')
    } catch {
      raw = undefined
    }
    const parsed = historyBackfillRequestSchema.safeParse(raw)
    if (!parsed.success || !isAbsolute(parsed.data.userDataPath)) {
      return invalidLaunch()
    }
    const userDataPath = realpathSync(parsed.data.userDataPath)
    host.setUserDataPath(userDataPath)
    // The maintenance owner is what stops a starting app from racing this write; the
    // single-instance lock is the second fence, forced on even for a launch form that
    // would normally bypass it.
    const maintenance = acquireProfileStateMaintenance(userDataPath)
    try {
      if (!host.acquireSingleInstanceLock()) {
        return {
          ok: false,
          code: 'runtime_error',
          message:
            'Stop Orca before `history backfill`: it writes the profile state database offline, and a running app would overwrite that write from memory. Quit Orca, run the command, then start Orca again.'
        }
      }
      const location = getActiveProfileStateLocation(userDataPath)
      if (!location) {
        return {
          ok: false,
          code: 'runtime_error',
          message:
            'Profile state has no active profile index. Start Orca once so this profile exists, stop it, then retry.'
        }
      }
      return {
        ok: true,
        result: await backfillTaskRecords({
          location,
          task: parsed.data.task,
          now: Date.now(),
          // The same two observations the archive snapshot is wired with; passing
          // them here is what keeps one resolver rule for both writers.
          sessionIndexLookup: createAiVaultSessionIndexLookup(),
          transcriptCheck: createTranscriptCheckProbe()
        })
      }
    } finally {
      maintenance.release()
    }
  } catch (error) {
    return {
      ok: false,
      code: isHistoryBackfillCommandError(error) ? error.code : 'runtime_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function invalidLaunch(): HistoryBackfillResponse {
  return {
    ok: false,
    code: 'invalid_argument',
    message: 'Invalid history backfill launch. Run `orca history backfill --task <repo>#<number>`.'
  }
}
